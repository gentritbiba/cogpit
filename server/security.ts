import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { timingSafeEqual, randomBytes } from "node:crypto"
import { getConfig } from "./config"
import { requestTargetPath, sendJson, MAX_REQUEST_BODY_BYTES, type NextFn } from "./http"
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  type SessionPrincipal,
} from "./sessionConstants"
import { editionModule, editionOwnsSignIn, type PersistentSessionStore, type SocketTransport } from "./edition"
import { shareRequestAllowed } from "./share/allowlist"
import { getShareWithHash, touchShare } from "./share/registry"
import { markShareGuestRequest } from "./share/requestGuest"
import { clearRequestAuthentication, setRequestAuthentication } from "./requestAuthentication"

// ── Network auth helpers ─────────────────────────────────────────────

const LOCAL_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])
const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
] as const

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const BROWSER_SESSION_COOKIE = "__Host-cogpit_session"
const SESSION_ACTIVITY_PERSIST_INTERVAL_MS = 60 * 1000

// Defined in ./sessionConstants so an edition's session modules can share them
// without importing this file back (security.ts imports them — the reverse
// edge would be an import cycle). This module stays their public home.
export { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS }
export type { SessionPrincipal }

export function isLocalRequest(req: IncomingMessage): boolean {
  return LOCAL_ADDRS.has(req.socket.remoteAddress || "")
}

function requestHostname(req: IncomingMessage): string | null {
  const host = req.headers.host
  if (!host) return null
  try {
    return new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return null
  }
}

/**
 * A loopback socket alone is not a trust boundary: DNS rebinding can make a
 * browser send a request to 127.0.0.1 while retaining an attacker-controlled
 * Host header. Local auth bypasses are therefore limited to literal loopback
 * hosts used by the desktop app and local development server.
 */
export function isTrustedLocalHost(req: IncomingMessage): boolean {
  const hostname = requestHostname(req)
  return hostname !== null && LOCAL_HOSTS.has(hostname)
}

/**
 * A reverse proxy terminating on loopback is still a remote trust boundary.
 * Standard forwarding headers make that boundary explicit so proxied requests
 * follow the password/session-token path even when the proxy rewrites Host.
 */
export function isForwardedRequest(req: IncomingMessage): boolean {
  return FORWARDING_HEADERS.some((header) => req.headers[header] !== undefined)
}

export function isTrustedDirectLocalRequest(req: IncomingMessage): boolean {
  return isLocalRequest(req) && isTrustedLocalHost(req) && !isForwardedRequest(req)
}

export function isUnforwardedUntrustedLoopback(req: IncomingMessage): boolean {
  return isLocalRequest(req) && !isForwardedRequest(req) && !isTrustedLocalHost(req)
}

function hasSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (!origin || !host) return false

  try {
    const parsed = new URL(origin)
    const expectedProtocol = requestUsesHttps(req) ? "https:" : "http:"
    return parsed.protocol === expectedProtocol && parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** A state-changing request whose browser source metadata does not vouch for it. */
export function isUntrustedMutation(req: IncomingMessage): boolean {
  return !SAFE_METHODS.has((req.method || "GET").toUpperCase()) && !hasTrustedMutationSource(req)
}

export function hasTrustedMutationSource(req: IncomingMessage): boolean {
  // Any explicit browser origin must match, even if a custom client header is
  // present. This fails closed for extensions, permissive CORS proxies, and
  // future callers that can set X-Cogpit-Client cross-origin.
  if (req.headers.origin && !hasSameOrigin(req)) return false

  const fetchSite = req.headers["sec-fetch-site"]
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false

  // At this point the request is same-origin or carries no browser source
  // metadata. The latter keeps headerless curl/agent clients compatible.
  return true
}

function requestUsesHttps(req: IncomingMessage): boolean {
  if ((req.socket as (typeof req.socket & { encrypted?: boolean }) | undefined)?.encrypted) return true
  if (!isForwardedRequest(req)) return false

  const forwardedProto = req.headers["x-forwarded-proto"]
  const firstProto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto?.split(",")[0]
  if (firstProto?.trim().toLowerCase() === "https") return true

  const forwarded = req.headers.forwarded
  const value: string | undefined = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return value?.split(",")[0]?.split(";").some((part: string) => part.trim().toLowerCase() === "proto=https") ?? false
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const pair of raw.split(";")) {
    const index = pair.indexOf("=")
    if (index === -1 || pair.slice(0, index).trim() !== name) continue
    return pair.slice(index + 1).trim() || null
  }
  return null
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  return header?.startsWith("Bearer ") ? header.slice(7) || null : null
}

export function getRequestSessionToken(req: IncomingMessage): string | null {
  return bearerToken(req) ?? cookieValue(req, BROWSER_SESSION_COOKIE)
}

function writeSessionCookie(res: ServerResponse, name: string, token: string | null): void {
  const maxAge = token === null ? 0 : Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000)
  res.setHeader(
    "Set-Cookie",
    `${name}=${token ?? ""}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
  )
}

export function setBrowserSessionCookie(res: ServerResponse, token: string): void {
  writeSessionCookie(res, BROWSER_SESSION_COOKIE, token)
}

export function clearBrowserSessionCookie(res: ServerResponse): void {
  writeSessionCookie(res, BROWSER_SESSION_COOKIE, null)
}

export function canIssueBrowserSession(req: IncomingMessage): boolean {
  return requestUsesHttps(req) && hasTrustedMutationSource(req)
}

/**
 * Return the HTTP rejection status for a PTY WebSocket upgrade, or `null` when
 * the request is authorized. Browser-originated loopback sockets must be both
 * literal-loopback Host requests and same-origin, closing cross-site WebSocket
 * hijacking and DNS-rebinding paths without breaking headerless CLI clients.
 */
export function websocketUpgradeRejection(
  req: IncomingMessage,
  url: URL,
): 401 | 403 | null {
  if (isUnforwardedUntrustedLoopback(req)) return 403

  if (editionOwnsSignIn()) return namedUserWebsocketRejection(req, url)

  if (isTrustedDirectLocalRequest(req)) {
    if (req.headers.origin && !hasSameOrigin(req)) return 403
    return null
  }

  const config = getConfig()
  if (!config?.networkAccess || !config.networkPassword) return 401

  const origin = req.headers.origin
  if (origin) {
    const token = cookieValue(req, BROWSER_SESSION_COOKIE)
    if (!hasSameOrigin(req)) return 403
    if (!token || !validateSessionToken(token, req.headers["user-agent"])) return 401
    return null
  }

  // Headerless machine clients and the hub-to-device proxy retain the query
  // token handshake. Browser WebSockets must use the HttpOnly cookie above, so
  // their credentials never enter URLs, logs, or browser history.
  const token = url.searchParams.get("token")
  if (!token || !validateSessionToken(token)) {
    return 401
  }
  return null
}

/** Write and close an unauthorized WebSocket upgrade, returning true when handled. */
export function rejectWebsocketUpgrade(
  req: IncomingMessage,
  url: URL,
  socket: Duplex,
): boolean {
  const status = websocketUpgradeRejection(req, url)
  if (!status) return false

  const reason = status === 401 ? "Unauthorized" : "Forbidden"
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`)
  socket.destroy()
  return true
}

/**
 * An edition that signs accounts in: local trust is off, and the edition
 * decides who holds a socket. Browser clients need a same-origin upgrade with
 * a valid session cookie; machine clients keep the ?token= handshake. The
 * networkAccess config gate does not apply — account credentials replace the
 * network password entirely.
 */
function namedUserWebsocketRejection(req: IncomingMessage, url: URL): 401 | 403 | null {
  let token: string | null
  if (req.headers.origin) {
    if (!hasSameOrigin(req)) return 403
    token = cookieValue(req, BROWSER_SESSION_COOKIE)
    if (!token || !validateSessionToken(token, req.headers["user-agent"])) return 401
  } else {
    token = url.searchParams.get("token")
    if (!token || !validateSessionToken(token)) return 401
  }
  return editionAdmitsSocket(token, socketTransportFor(url.pathname)) ? null : 403
}

/**
 * Which transport an upgrade path opens. Only this server's own `/__browser`
 * is a browser viewer, which checks its caller against the browser it shows;
 * a hub upgrade reaches a whole device, as the terminal does.
 */
export function socketTransportFor(pathname: string): SocketTransport {
  return pathname === "/__browser" ? "browser" : "terminal"
}

/** Whether the edition lets the session behind `token` hold a `transport` socket now. Principal-less legacy tokens never do. */
export function editionAdmitsSocket(token: string, transport: SocketTransport): boolean {
  const principal = getSessionPrincipal(token)
  return principal !== null && editionModule().auth?.admitsSocket(principal, transport) === true
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

// ── Session token system ────────────────────────────────────────────

interface SessionInfo {
  createdAt: number
  ip: string
  userAgent: string
  lastActivity: number
  persistedActivityAt: number
  principal?: SessionPrincipal
}

const activeSessions = new Map<string, SessionInfo>()
type SessionRevocationListener = (token: string | null) => void
const sessionRevocationListeners = new Set<SessionRevocationListener>()

function logPersistenceFailure(error: unknown): void {
  console.error("[sessions] Failed to write the persisted session store:", error)
}

/**
 * A live-process invalidation (idle/absolute expiry, UA mismatch, revocation,
 * sweep) must also drop the persisted row, or the edition's restore path
 * would resurrect the session the next time the token is presented. Only
 * process death skips this — which is exactly what leaves not-yet-expired
 * sessions restorable after a restart.
 */
function notifySessionRevoked(token: string | null): void {
  for (const listener of sessionRevocationListeners) {
    try {
      listener(token)
    } catch (error) {
      console.error("[sessions] Revocation listener failed:", error)
    }
  }
}

/** Subscribe upgraded transports that must close when their token is revoked. */
export function onSessionRevoked(listener: SessionRevocationListener): () => void {
  sessionRevocationListeners.add(listener)
  return () => sessionRevocationListeners.delete(listener)
}

const HTTP_STREAM_AUTHORIZATION_RECHECK_MS = 5_000

/**
 * The API path a stream request names, with the `/hub/:deviceId` prefix of a
 * proxied one removed.
 *
 * Read from the path exactly as sent, for the same reason isPublicPath is:
 * resolving `/api/watch/a/../../..` to "/" would classify a request the router
 * still dispatches to the watch handler as "not a stream", and it would then
 * outlive the revocation of the token that opened it.
 */
function authenticatedStreamApiPath(rawUrl: string): string | null {
  const target = requestTargetPath(rawUrl)
  if (target === null) return null
  const path = target.toLowerCase()
  const hub = /^\/hub\/[^/]+(\/api(?:\/.*)?)$/.exec(path)
  return hub?.[1] ?? path
}

/** Only endpoints whose successful GET response is intentionally long-lived. */
export function isAuthenticatedHttpStreamRequest(req: IncomingMessage): boolean {
  if ((req.method || "GET").toUpperCase() !== "GET") return false
  const path = authenticatedStreamApiPath(req.url || "/")
  return path === "/api/task-output"
    || path === "/api/watch"
    || path?.startsWith("/api/watch/") === true
    || path === "/api/team-watch"
    || path?.startsWith("/api/team-watch/") === true
    || path === "/api/workflow-watch"
    || path?.startsWith("/api/workflow-watch/") === true
}

/** An edition's hold on a stream's session access, kept in step with the token's. */
export interface HttpStreamAccess {
  /** Re-check the stream's access now. */
  recheck(): void
  unbind(): void
}

/** Binds a stream's session access; called only for a request that is a stream. */
export type HttpStreamAccessBinder = () => HttpStreamAccess | null

interface StreamTokenBinding {
  onRevoked: (listener: (revokedToken: string | null) => void) => () => void
  /** Must not refresh idle time — a recheck may not keep its own stream alive. */
  isActive: (token: string) => boolean
  /** An edition that scopes sessions per user keeps the stream's access in step. */
  bindAccess?: HttpStreamAccessBinder
}

/**
 * Bind a long-lived HTTP response to the token that admitted it. Normal
 * responses unregister on finish; SSE responses are destroyed when that token
 * is revoked (logout, disable/demotion/password reset, share turned off,
 * global revocation) or stops being active. With `bindAccess`, a stream also
 * ends once its caller loses access to the session it serves.
 */
function trackRevocableHttpStream(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  binding: StreamTokenBinding,
): void {
  if (!isAuthenticatedHttpStreamRequest(req)) return

  let cleaned = false
  let timer: ReturnType<typeof setInterval> | null = null
  let unsubscribe = (): void => {}
  const access = binding.bindAccess?.() ?? null
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    if (timer) clearInterval(timer)
    unsubscribe()
    access?.unbind()
  }
  const terminate = (): void => {
    cleanup()
    if (!res.writableEnded) res.destroy()
  }
  unsubscribe = binding.onRevoked((revokedToken) => {
    if (revokedToken === null || revokedToken === token) terminate()
  })
  timer = setInterval(() => {
    if (!binding.isActive(token)) terminate()
    else access?.recheck()
  }, HTTP_STREAM_AUTHORIZATION_RECHECK_MS)
  timer.unref?.()
  res.once("finish", cleanup)
  res.once("close", cleanup)
}

/** Bind a stream a main session token admitted to that token (see trackRevocableHttpStream). */
export function trackAuthenticatedHttpStream(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  bindAccess?: HttpStreamAccessBinder,
): void {
  trackRevocableHttpStream(req, res, token, {
    onRevoked: onSessionRevoked,
    isActive: isSessionTokenActive,
    bindAccess,
  })
}

/** Where an edition keeps login sessions across restarts; personal edition keeps none. */
function persistentSessions(): PersistentSessionStore | null {
  return editionModule().auth?.sessions ?? null
}

/** Resolves once every persisted login change so far is on disk. */
export function flushPersistentSessions(): Promise<void> {
  return persistentSessions()?.flush() ?? Promise.resolve()
}

function discardSession(token: string): Promise<void> {
  if (activeSessions.delete(token)) notifySessionRevoked(token)
  return persistentSessions()?.remove(token) ?? Promise.resolve()
}

function discardSessionBestEffort(token: string): void {
  void discardSession(token).catch(logPersistenceFailure)
}

export function createSessionToken(ip: string, userAgent?: string, principal?: SessionPrincipal): string {
  const token = randomBytes(32).toString("hex")
  const now = Date.now()
  activeSessions.set(token, {
    createdAt: now,
    ip,
    userAgent: userAgent || "",
    lastActivity: now,
    persistedActivityAt: now,
    principal,
  })
  const persistent = persistentSessions()
  if (principal && persistent) {
    void persistent.persist(token, principal, now).catch(logPersistenceFailure)
  }
  return token
}

/** The live in-memory session for a token, or null once expired (expiry discards it). */
function getLiveSession(token: string): SessionInfo | null {
  const session = activeSessions.get(token)
  if (!session) return null
  const now = Date.now()
  if (
    now - session.createdAt > SESSION_ABSOLUTE_TTL_MS
    || now - session.lastActivity > SESSION_IDLE_TTL_MS
  ) {
    discardSessionBestEffort(token)
    return null
  }
  return session
}

/**
 * Rehydrate a persisted session after a restart. The edition re-reads the
 * principal so role changes apply and disabled users stay out; the original
 * createdAt is kept so the absolute TTL spans restarts. The presenting
 * request's user agent becomes the pinned one — the original was never
 * persisted.
 */
function restorePersistedSession(
  store: PersistentSessionStore,
  token: string,
  userAgent: string | undefined,
): SessionInfo | null {
  const restored = store.restore(token)
  if (!restored) return null
  const now = Date.now()
  if (
    now - restored.createdAt > SESSION_ABSOLUTE_TTL_MS
    || now - restored.lastActivity > SESSION_IDLE_TTL_MS
    || !restored.principal
  ) {
    discardSessionBestEffort(token)
    return null
  }
  const session: SessionInfo = {
    createdAt: restored.createdAt,
    ip: "",
    userAgent: userAgent ?? "",
    lastActivity: restored.lastActivity,
    persistedActivityAt: restored.lastActivity,
    principal: restored.principal,
  }
  activeSessions.set(token, session)
  return session
}

export function validateSessionToken(token: string, userAgent?: string): boolean {
  const persistent = persistentSessions()
  const session = getLiveSession(token)
    ?? (persistent ? restorePersistedSession(persistent, token, userAgent) : null)
  if (!session) return false
  if (userAgent !== undefined && session.userAgent !== userAgent) {
    discardSessionBestEffort(token)
    return false
  }
  const now = Date.now()
  session.lastActivity = now
  if (
    session.principal
    && persistent
    && now - session.persistedActivityAt >= SESSION_ACTIVITY_PERSIST_INTERVAL_MS
  ) {
    session.persistedActivityAt = now
    void persistent.touch(token, now).catch(logPersistenceFailure)
  }
  return true
}

/** Principal of a currently valid session; does not refresh lastActivity. */
export function getSessionPrincipal(token: string): SessionPrincipal | null {
  return getLiveSession(token)?.principal ?? null
}

/** Validity check for long-lived transports that must not refresh idle time. */
export function isSessionTokenActive(token: string): boolean {
  return getLiveSession(token) !== null
}

export function revokeSessionToken(token: string): Promise<void> {
  return discardSession(token)
}

export function revokeAllSessions(): Promise<void> {
  activeSessions.clear()
  notifySessionRevoked(null)
  return persistentSessions()?.clear() ?? Promise.resolve()
}

export function revokeSessionsForPrincipal(userId: string): Promise<void> {
  for (const [token, session] of activeSessions) {
    if (session.principal?.userId !== userId) continue
    activeSessions.delete(token)
    notifySessionRevoked(token)
  }
  return persistentSessions()?.removeForUser(userId) ?? Promise.resolve()
}

/** Clears only the in-memory session map — simulates a process restart in tests. */
export function __resetSessionsForTest(): void {
  activeSessions.clear()
}

export function getConnectedDevices(): Array<{ ip: string; userAgent: string; deviceName: string; connectedAt: number; lastActivity: number }> {
  const now = Date.now()
  const devices: Array<{ ip: string; userAgent: string; deviceName: string; connectedAt: number; lastActivity: number }> = []
  for (const [token, session] of activeSessions) {
    if (
      now - session.createdAt > SESSION_ABSOLUTE_TTL_MS
      || now - session.lastActivity > SESSION_IDLE_TTL_MS
    ) {
      discardSessionBestEffort(token)
      continue
    }
    devices.push({
      ip: session.ip.replace(/^::ffff:/, ""),
      userAgent: session.userAgent,
      deviceName: parseDeviceName(session.userAgent),
      connectedAt: session.createdAt,
      lastActivity: session.lastActivity,
    })
  }
  return devices
}

function parseDeviceName(ua: string): string {
  if (!ua) return "Unknown device"
  if (/iPhone/.test(ua)) return "iPhone"
  if (/iPad/.test(ua)) return "iPad"
  if (/Macintosh|Mac OS/.test(ua)) return "Mac"
  if (/Windows/.test(ua)) return "Windows PC"
  if (/Android/.test(ua)) {
    const match = ua.match(/;\s*([^;)]+)\s*Build\//)
    if (match) return match[1].trim()
    return "Android device"
  }
  if (/Linux/.test(ua)) return "Linux"
  return "Unknown device"
}

// Clean up expired sessions periodically (unref so build process can exit)
setInterval(() => {
  const now = Date.now()
  for (const [token, session] of activeSessions) {
    if (
      now - session.createdAt > SESSION_ABSOLUTE_TTL_MS
      || now - session.lastActivity > SESSION_IDLE_TTL_MS
    ) discardSessionBestEffort(token)
  }
}, 60_000).unref()

// ── Share token system ───────────────────────────────────────────────
//
// A share token grants full participation in exactly ONE session. It is kept
// in its own map rather than `activeSessions` because a share principal is not
// a signed-in principal: it must never satisfy the main auth path, never
// persist to the edition's session store, and never appear in
// getConnectedDevices().

const SHARE_COOKIE = "__Host-cogpit_share"

interface ShareTokenInfo {
  sessionId: string
  createdAt: number
  ip: string
  userAgent: string
  lastActivity: number
}

const shareTokens = new Map<string, ShareTokenInfo>()
type ShareRevocationListener = (token: string | null) => void
const shareRevocationListeners = new Set<ShareRevocationListener>()

function notifyShareRevoked(token: string | null): void {
  for (const listener of shareRevocationListeners) {
    try {
      listener(token)
    } catch (error) {
      console.error("[share] Revocation listener failed:", error)
    }
  }
}

/** Subscribe guest transports that must close when their share is revoked. */
export function onShareRevoked(listener: ShareRevocationListener): () => void {
  shareRevocationListeners.add(listener)
  return () => shareRevocationListeners.delete(listener)
}

function discardShareToken(token: string): void {
  if (shareTokens.delete(token)) notifyShareRevoked(token)
}

/**
 * Live guests one share may hold at once.
 *
 * Sharing is a one-to-one or small-group workflow, but each login mints a new
 * token and the cookie is its only holder: a guest who clears cookies, opens
 * the link on a second device, or idles past the 30-minute window and logs
 * back in leaves the old token behind. Uncapped they accumulate for the whole
 * 8-hour absolute TTL, and the live guest count the host reads before deciding
 * whether to stop sharing drifts upward with every reconnect.
 *
 * Eight is well above what the feature is for — enough that a flaky tunnel
 * reconnecting a couple of real people never evicts anyone mid-session — and
 * small enough that the number on screen still means something.
 */
export const MAX_SHARE_GUESTS_PER_SESSION = 8

/** Drop the oldest live tokens for `sessionId` until it is inside the cap. */
function evictOldestShareTokens(sessionId: string): void {
  // Mints only ever append, so the map's insertion order is age order and the
  // survivors are the tail.
  const live = [...shareTokens.keys()].filter(
    (token) => getLiveShare(token)?.sessionId === sessionId,
  )
  const excess = live.length - MAX_SHARE_GUESTS_PER_SESSION
  for (let i = 0; i < excess; i++) discardShareToken(live[i])
}

/**
 * Mint a guest token. `userAgent` is required and "" is a real value: a client
 * that sends no User-Agent is pinned to the absence of one, so it stays pinned
 * against a client that sends one.
 */
export function createShareToken(sessionId: string, ip: string, userAgent: string): string {
  const token = randomBytes(32).toString("hex")
  const now = Date.now()
  shareTokens.set(token, {
    sessionId,
    createdAt: now,
    ip,
    userAgent,
    lastActivity: now,
  })
  evictOldestShareTokens(sessionId)
  return token
}

/** The live share for a token, or null once expired (expiry discards it). */
function getLiveShare(token: string): ShareTokenInfo | null {
  const share = shareTokens.get(token)
  if (!share) return null
  const now = Date.now()
  if (
    now - share.createdAt > SESSION_ABSOLUTE_TTL_MS
    || now - share.lastActivity > SESSION_IDLE_TTL_MS
  ) {
    discardShareToken(token)
    return null
  }
  return share
}

/**
 * The session a share token admits its holder to, or null if it is not valid.
 *
 * The pin is unconditional. Skipping it for a request that carries no
 * User-Agent would make the pin opt-out for whoever replays a stolen cookie
 * with curl, which is the case it exists to catch. Callers pass
 * `req.headers["user-agent"] ?? ""`, matching how the token was minted.
 */
export function validateShareToken(token: string, userAgent: string): string | null {
  const share = getLiveShare(token)
  if (!share) return null
  if (share.userAgent !== userAgent) {
    discardShareToken(token)
    return null
  }
  share.lastActivity = Date.now()
  return share.sessionId
}

/**
 * Validity check for long-lived transports that must not refresh idle time.
 *
 * The registry is consulted as well as the token map, so an SSE stream closes
 * on the next recheck when the host stops sharing, whether or not anything
 * remembered to revoke the token. A guest stream never issues another request,
 * so this recheck is the only thing standing between "Stop sharing" and a
 * transcript that keeps streaming.
 */
export function isShareTokenActive(token: string): boolean {
  const share = getLiveShare(token)
  return share !== null && getShareWithHash(share.sessionId) !== undefined
}

export function revokeShareToken(token: string): void {
  discardShareToken(token)
}

export function revokeShareTokensForSession(sessionId: string): void {
  for (const [token, share] of shareTokens) {
    if (share.sessionId !== sessionId) continue
    shareTokens.delete(token)
    notifyShareRevoked(token)
  }
}

export function revokeAllShareTokens(): void {
  shareTokens.clear()
  notifyShareRevoked(null)
}

/** Guests currently holding an unexpired token for a session. */
export function countShareGuests(sessionId: string): number {
  let count = 0
  for (const token of [...shareTokens.keys()]) {
    if (getLiveShare(token)?.sessionId === sessionId) count++
  }
  return count
}

export function setShareCookie(res: ServerResponse, token: string): void {
  writeSessionCookie(res, SHARE_COOKIE, token)
}

/**
 * Cookie only, deliberately. `Authorization: Bearer` is the machine-client path
 * to unrestricted access; letting a share token ride it would hand a guest the
 * full-access branch of every middleware that reads a bearer header.
 */
export function getRequestShareToken(req: IncomingMessage): string | null {
  return cookieValue(req, SHARE_COOKIE)
}

/** Clears only the in-memory share map — the tokens are never persisted. */
export function __resetShareTokensForTest(): void {
  shareTokens.clear()
}

// Clean up expired share tokens periodically (unref so build process can exit)
setInterval(() => {
  for (const token of [...shareTokens.keys()]) getLiveShare(token)
}, 60_000).unref()

// ── Password hashing ────────────────────────────────────────────────

export {
  hashPassword,
  isMalformedPasswordHash,
  isPasswordHashed,
  needsPasswordRehash,
  validatePasswordStrength,
  verifyPassword,
  verifyPasswordAsync,
} from "./password-utils"

// ── Security headers middleware ──────────────────────────────────────

function setSecurityHeaders(req: IncomingMessage, res: ServerResponse): void {
  res.removeHeader?.("X-Powered-By")
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "DENY")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
  res.setHeader("X-XSS-Protection", "0")
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin")
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin")
  const host = req.headers.host
  const socketOrigin = host && /^[a-z0-9.:[\]-]+$/i.test(host)
    ? `${requestUsesHttps(req) ? "wss" : "ws"}://${host}`
    : null
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'${socketOrigin ? ` ${socketOrigin}` : ""}; worker-src 'self' blob:; manifest-src 'self'`,
  )
  if (requestUsesHttps(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000")
  }
  if (isProtectedTransportRequest(req)) {
    res.setHeader("Cache-Control", "no-store")
  }
}

export function securityHeaders(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  setSecurityHeaders(req, res)
  next()
}

export function devSecurityHeaders(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  if (isProtectedTransportRequest(req)) setSecurityHeaders(req, res)
  next()
}

// ── Body size limit ─────────────────────────────────────────────────

export function bodySizeLimit(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") return next()

  let size = 0
  const contentLength = parseInt(req.headers["content-length"] || "", 10)
  if (contentLength > MAX_REQUEST_BODY_BYTES) {
    res.statusCode = 413
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Request body too large" }))
    return
  }

  const origOn = req.on.bind(req)
  req.on = function (event: string, listener: (...args: unknown[]) => void) {
    if (event === "data") {
      const wrapped = (chunk: Buffer | string) => {
        size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
        if (size > MAX_REQUEST_BODY_BYTES) {
          res.statusCode = 413
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Request body too large" }))
          req.destroy()
          return
        }
        ;(listener as (chunk: Buffer | string) => void)(chunk)
      }
      return origOn(event, wrapped)
    }
    return origOn(event, listener)
  } as typeof req.on

  next()
}

// ── Auth middleware ──────────────────────────────────────────────────

// /api/share/verify is public on purpose: it is where a guest whose token has
// expired gets a new one. Behind the share branch it would answer 403 and the
// guest could never log back in.
const PUBLIC_PATHS = new Set(["/api/auth/verify", "/api/hello", "/api/share/verify"])

// /hub/* is the multi-device reverse proxy — protected exactly like /api/*.
const PROTECTED_TRANSPORT_PREFIXES = ["/api/", "/__pty", "/__browser", "/hub/"] as const

function startsWithProtectedPrefix(path: string): boolean {
  // Express routes case-insensitively, so a case-variant prefix (/HUB, /API,
  // /__PTY) would still reach the protected handlers while a case-sensitive
  // prefix check treated it as public — an unauthenticated remote shell for
  // every registered device. Lowercase before comparing so it can't slip past.
  const lower = path.toLowerCase()
  return PROTECTED_TRANSPORT_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * True when `path` names the API, the hub proxy, or a socket transport (PTY,
 * browser viewer) — the transports that require authentication and must never
 * be cached.
 *
 * Both the path as sent and its single percent-decode are tested, and either
 * hit protects the request. Decoding here can only ever widen what is
 * protected: the routers dispatch on the undecoded path, so `/%61pi/me`
 * reaches no handler and answering 401 to it costs nothing. Re-normalizing a
 * decoded path would be the opposite kind of change and is deliberately absent
 * — see requestTargetPath.
 */
function isProtectedTransportPath(path: string): boolean {
  if (startsWithProtectedPrefix(path)) return true
  try {
    return startsWithProtectedPrefix(decodeURIComponent(path))
  } catch {
    // An undecodable target is one nobody can reason about. Protect it.
    return true
  }
}

/** A request target that cannot be reduced to a path is never public. */
function isProtectedTransportRequest(req: IncomingMessage): boolean {
  const path = requestTargetPath(req.url || "/")
  return path === null || isProtectedTransportPath(path)
}

/** Reachable without credentials: the login endpoints, discovery, and anything outside the API and transports. */
export function isPublicPath(url: string): boolean {
  const path = requestTargetPath(url)
  if (path === null) return false
  return PUBLIC_PATHS.has(path) || !isProtectedTransportPath(path)
}

/** The presented main-session token, or null when there is no valid one. */
export function validSessionToken(req: IncomingMessage): string | null {
  const bearer = bearerToken(req)
  const browserCookie = cookieValue(req, BROWSER_SESSION_COOKIE)
  const token = bearer ?? browserCookie
  if (!token) return null
  // A bearer token is a machine client, which has no user agent to pin against.
  //
  // Deliberately asymmetric with validateShareToken: a cookie request that
  // sends no User-Agent header skips the pin here. That weakness predates
  // sharing and is left alone rather than tightened in passing — main sessions
  // are minted for clients this file does not enumerate, so changing it is its
  // own change with its own blast radius.
  const userAgent = browserCookie && !bearer ? req.headers["user-agent"] : undefined
  return validateSessionToken(token, userAgent) ? token : null
}

/**
 * Why an edition turns away a guest whose share is live, or null to admit it.
 * Asked on every guest request and at every recheck of a guest stream, so a
 * refusal also ends the streams a guest already has open.
 */
export type ShareGuestRefusal = () => { error: string; code: string } | null

/**
 * A share guest's entire request surface. This function always responds or
 * calls next() — it never falls through to the full-access paths that follow
 * it, so a share cookie arriving on loopback (a tunnel terminating locally, a
 * browser on the host) cannot be upgraded by the local-trust shortcut.
 */
export function handleShareRequest(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
  token: string,
  guestRefusal?: ShareGuestRefusal,
): void {
  // A share is remote access, so it lives behind the same switch as every
  // other remote request. This branch sits above the gate in both middlewares,
  // so without the check here a guest would be admitted on a request an
  // ordinary remote user gets 403 on. An edition that signs accounts in
  // replaces the network password with their credentials, and the host's own
  // loopback browser is trusted there as everywhere else.
  if (!isTrustedDirectLocalRequest(req) && !editionOwnsSignIn()) {
    const config = getConfig()
    if (!config?.networkAccess || !config?.networkPassword) {
      return sendJson(res, 403, { error: "Network access is disabled" })
    }
  }

  const sessionId = validateShareToken(token, req.headers["user-agent"] ?? "")
  if (!sessionId) return sendJson(res, 401, { error: "Share authentication required" })

  const share = getShareWithHash(sessionId)
  if (!share) {
    // The share was turned off while the token was still live.
    revokeShareToken(token)
    return sendJson(res, 401, { error: "Share authentication required" })
  }

  // Asked only once the share is proven, so a made-up cookie learns nothing.
  const refusal = guestRefusal?.()
  if (refusal) return sendJson(res, 403, refusal)

  if (isUntrustedMutation(req)) {
    return sendJson(res, 403, { error: "Untrusted request source" })
  }

  if (!shareRequestAllowed((req.method || "GET").toUpperCase(), req.url || "/", share)) {
    return sendJson(res, 403, { error: "Not available on a shared session" })
  }

  touchShare(sessionId)
  trackRevocableHttpStream(req, res, token, {
    onRevoked: onShareRevoked,
    isActive: (active) => isShareTokenActive(active) && !guestRefusal?.(),
  })
  // The edition's authz middleware runs next and may refuse every request it
  // cannot account for. A guest carries no SessionPrincipal by design, so it
  // has to arrive there labelled as a guest rather than as nothing at all.
  markShareGuestRequest(req, sessionId)
  next()
}

export function authMiddleware(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  clearRequestAuthentication(req)
  const editionAuth = editionModule().auth
  if (editionAuth) return editionAuth.middleware(req, res, next)

  const url = req.url || "/"
  const publicPath = isPublicPath(url)

  if (!publicPath && isUnforwardedUntrustedLoopback(req)) {
    return sendJson(res, 403, { error: "Untrusted local host" })
  }

  if (publicPath) return next()

  // A valid main session wins; anything less enters the guest branch, which
  // never comes back to the full-access paths below.
  const shareToken = getRequestShareToken(req)
  if (shareToken && !validSessionToken(req)) {
    return handleShareRequest(req, res, next, shareToken)
  }

  if (isTrustedDirectLocalRequest(req)) {
    if (isUntrustedMutation(req)) {
      return sendJson(res, 403, { error: "Untrusted request source" })
    }
    const token = validSessionToken(req)
    setRequestAuthentication(req, token
      ? { kind: "session", token, principal: getSessionPrincipal(token) }
      : { kind: "local" })
    return next()
  }

  const config = getConfig()
  if (!config?.networkAccess || !config?.networkPassword) {
    return sendJson(res, 403, { error: "Network access is disabled" })
  }

  const sessionToken = validSessionToken(req)
  if (!sessionToken) {
    return sendJson(res, 401, { error: "Authentication required" })
  }

  if (isUntrustedMutation(req)) {
    return sendJson(res, 403, { error: "Untrusted request source" })
  }

  trackAuthenticatedHttpStream(req, res, sessionToken)
  setRequestAuthentication(req, { kind: "session", token: sessionToken, principal: getSessionPrincipal(sessionToken) })
  next()
}
