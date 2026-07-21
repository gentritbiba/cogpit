import type { IncomingMessage, ServerResponse } from "node:http"
import { timingSafeEqual, randomBytes } from "node:crypto"
import { getConfig } from "./config"
import type { NextFn } from "./http"

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
const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000

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

function isUnforwardedUntrustedLoopback(req: IncomingMessage): boolean {
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

export function setBrowserSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `${BROWSER_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000)}`,
  )
}

export function clearBrowserSessionCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${BROWSER_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
  )
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
}

const activeSessions = new Map<string, SessionInfo>()

export function createSessionToken(ip: string, userAgent?: string): string {
  const token = randomBytes(32).toString("hex")
  const now = Date.now()
  activeSessions.set(token, { createdAt: now, ip, userAgent: userAgent || "", lastActivity: now })
  return token
}

export function validateSessionToken(token: string, userAgent?: string): boolean {
  const session = activeSessions.get(token)
  if (!session) return false
  const now = Date.now()
  if (
    now - session.createdAt > SESSION_ABSOLUTE_TTL_MS
    || now - session.lastActivity > SESSION_IDLE_TTL_MS
    || (userAgent !== undefined && session.userAgent !== userAgent)
  ) {
    activeSessions.delete(token)
    return false
  }
  session.lastActivity = now
  return true
}

export function revokeSessionToken(token: string): void {
  activeSessions.delete(token)
}

export function revokeAllSessions(): void {
  activeSessions.clear()
}

export function getConnectedDevices(): Array<{ ip: string; userAgent: string; deviceName: string; connectedAt: number; lastActivity: number }> {
  const now = Date.now()
  const devices: Array<{ ip: string; userAgent: string; deviceName: string; connectedAt: number; lastActivity: number }> = []
  for (const [, session] of activeSessions) {
    if (
      now - session.createdAt > SESSION_ABSOLUTE_TTL_MS
      || now - session.lastActivity > SESSION_IDLE_TTL_MS
    ) continue
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
    ) activeSessions.delete(token)
  }
}, 60_000).unref()

// ── Password hashing ────────────────────────────────────────────────

export {
  hashPassword,
  isMalformedPasswordHash,
  isPasswordHashed,
  needsPasswordRehash,
  verifyPassword,
  verifyPasswordAsync,
} from "./password-utils"

// ── Password validation ─────────────────────────────────────────────

export const MIN_PASSWORD_LENGTH = 16

export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  return null
}

// ── Security headers middleware ──────────────────────────────────────

export function securityHeaders(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
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
  const path = (req.url || "/").split("?")[0].toLowerCase()
  if (path.startsWith("/api/") || path.startsWith("/hub/") || path.startsWith("/__pty")) {
    res.setHeader("Cache-Control", "no-store")
  }
  next()
}

// ── Body size limit ─────────────────────────────────────────────────

const MAX_BODY_SIZE = 5 * 1024 * 1024 // 5MB

export function bodySizeLimit(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") return next()

  let size = 0
  const contentLength = parseInt(req.headers["content-length"] || "", 10)
  if (contentLength > MAX_BODY_SIZE) {
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
        if (size > MAX_BODY_SIZE) {
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

const PUBLIC_PATHS = new Set(["/api/auth/verify", "/api/hello"])

function isPublicPath(url: string): boolean {
  const path = url.split("?")[0]
  if (PUBLIC_PATHS.has(path)) return true
  // Express routes case-insensitively, so a case-variant prefix (/HUB, /API,
  // /__PTY) would still reach the protected handlers while a case-sensitive
  // prefix check treated it as public — an unauthenticated remote shell for
  // every registered device. Lowercase before comparing so it can't slip past.
  // /hub/* is the multi-device reverse proxy — protected exactly like /api/*.
  const lower = path.toLowerCase()
  if (!lower.startsWith("/api/") && !lower.startsWith("/__pty") && !lower.startsWith("/hub/")) return true
  return false
}

export function authMiddleware(req: IncomingMessage, res: ServerResponse, next: NextFn): void {
  const url = req.url || "/"
  const publicPath = isPublicPath(url)

  if (!publicPath && isUnforwardedUntrustedLoopback(req)) {
    res.statusCode = 403
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Untrusted local host" }))
    return
  }

  if (isTrustedDirectLocalRequest(req)) {
    const method = (req.method || "GET").toUpperCase()
    if (!publicPath && !SAFE_METHODS.has(method) && !hasTrustedMutationSource(req)) {
      res.statusCode = 403
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ error: "Untrusted request source" }))
      return
    }
    return next()
  }

  if (publicPath) return next()

  const config = getConfig()
  if (!config?.networkAccess || !config?.networkPassword) {
    res.statusCode = 403
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Network access is disabled" }))
    return
  }

  const bearer = bearerToken(req)
  const browserCookie = cookieValue(req, BROWSER_SESSION_COOKIE)
  const token = bearer ?? browserCookie
  const valid = token && validateSessionToken(
    token,
    browserCookie && !bearer ? req.headers["user-agent"] : undefined,
  )

  if (!valid) {
    res.statusCode = 401
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Authentication required" }))
    return
  }

  const method = (req.method || "GET").toUpperCase()
  if (!SAFE_METHODS.has(method) && !hasTrustedMutationSource(req)) {
    res.statusCode = 403
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ error: "Untrusted request source" }))
    return
  }

  next()
}
