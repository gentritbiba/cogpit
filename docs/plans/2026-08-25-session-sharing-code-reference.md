# Session Sharing — Code Reference

Working dir: `/Users/gentritbiba/agent-window/.worktrees/session-sharing`. All paths absolute below the repo root shown; line numbers are current HEAD.

---

## 1. `server/atomicJsonFile.ts` — full public API

`/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/atomicJsonFile.ts:1-39` (the **entire file** — 39 lines, two exports, **no read helper**):

```ts
import { chmod, rename, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"

/**
 * Atomically replace a JSON file from a same-directory owner-only temporary.
 * Readers therefore observe either the previous complete value or the new one,
 * never a truncated write after a crash or concurrent read.
 */
export async function writeOwnerOnlyText(
  filePath: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await writeFile(temporaryPath, content, {
      encoding: "utf-8",
      mode,
    })
    await chmod(temporaryPath, mode)
    await rename(temporaryPath, filePath)
    await chmod(filePath, mode)
  } catch (error) {
    try {
      await unlink(temporaryPath)
    } catch {
      // The temporary may not have been created or may already have moved.
    }
    throw error
  }
}

export async function writeOwnerOnlyJson(
  filePath: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  await writeOwnerOnlyText(filePath, JSON.stringify(value, null, 2), mode)
}
```

**There is no read helper.** Every caller does its own `readFile` + `JSON.parse` + `chmod(path, 0o600)` (see registry pattern in §2, session-config in §9).

---

## 2. `server/hub/registry.ts` — the clone-this pattern

### Module header + types (`server/hub/registry.ts:1-39`)

```ts
import { readFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { writeOwnerOnlyJson } from "../atomicJsonFile"

/**
 * Multi-device hub registry.
 *
 * Persists the set of remote Cogpit devices this hub can control to
 * `devices.local.json` in the same directory as `config.local.json`
 * (userDataDir in Electron, project root in dev). The file may contain a
 * device password, so it is written with mode 0600 and re-chmodded after
 * every write (writeFile's mode only applies at file *creation*).
 *
 * Runtime status (auth state, last probe/hello) is kept in memory only and
 * merged into `listDevices()` output — it is never persisted and passwords
 * are never serialized out of this module via the public list.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface HubDevice {
  /** "dev_" + 8 random bytes hex */
  id: string
  name: string
  host: string
  /** device HTTP port, defaults to 19384 (443 when tls) */
  port: number
  /** reach the device over https (e.g. behind a TLS-terminating proxy); only stored when true */
  tls?: boolean
  auth: "password" | "none"
  /** only present for auth === "password"; never serialized by listDevices */
  password?: string
  /** team-edition device login: authenticate as this user (Bearer user:pass) */
  username?: string
  /** Monotonic scope version; advances only when the connection/account tuple changes. */
  connectionRevision?: number
  addedAt: number
}
```

### Module state + normalize + queue + persist (`server/hub/registry.ts:88-145`)

```ts
const DEFAULT_PORT = 19384
const DEFAULT_TLS_PORT = 443

// ── Module state ─────────────────────────────────────────────────────

let registryPath: string | null = null
const devices = new Map<string, HubDevice>()
const runtimes = new Map<string, DeviceRuntime>()
let registryOperationQueue: Promise<void> = Promise.resolve()

// ── Persistence ──────────────────────────────────────────────────────

function normalizeDevice(entry: unknown): HubDevice | null {
  if (!entry || typeof entry !== "object") return null
  const e = entry as Record<string, unknown>
  if (typeof e.id !== "string" || typeof e.host !== "string") return null
  const auth = e.auth === "none" ? "none" : "password"
  return {
    id: e.id,
    name: typeof e.name === "string" ? e.name : e.host,
    host: e.host,
    port: typeof e.port === "number" && Number.isFinite(e.port) ? e.port : DEFAULT_PORT,
    tls: e.tls === true ? true : undefined,
    auth,
    password: auth === "password" && typeof e.password === "string" ? e.password : undefined,
    username: auth === "password" && typeof e.username === "string" ? e.username : undefined,
    connectionRevision: typeof e.connectionRevision === "number"
      && Number.isSafeInteger(e.connectionRevision)
      && e.connectionRevision >= 0
      ? e.connectionRevision
      : 0,
    addedAt: typeof e.addedAt === "number" ? e.addedAt : 0,
  }
}

function enqueueRegistryOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = registryOperationQueue.then(operation)
  // A rejected persistence attempt belongs to its caller. Keep a handled tail
  // so later operations still run rather than inheriting the rejection.
  registryOperationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function replaceDevices(nextDevices: ReadonlyMap<string, HubDevice>): void {
  devices.clear()
  for (const [id, device] of nextDevices) devices.set(id, device)
}

async function persist(
  filePath: string | null,
  snapshot: readonly HubDevice[],
): Promise<void> {
  if (!filePath) return
  await writeOwnerOnlyJson(filePath, snapshot)
}
```

### `commitDeviceMutation` (`server/hub/registry.ts:147-174`)

```ts
interface DeviceMutation<T> {
  changed: boolean
  value: T
  commitRuntime?: () => void
}

function commitDeviceMutation<T>(
  mutate: (draft: Map<string, HubDevice>) => DeviceMutation<T>,
): Promise<T> {
  return enqueueRegistryOperation(async () => {
    // Clone records as well as the map so an existing device reference cannot
    // change the candidate while its atomic write is in flight.
    const draft = new Map(
      [...devices].map(([id, device]) => [id, { ...device }]),
    )
    const mutation = mutate(draft)
    if (!mutation.changed) return mutation.value

    // The durable snapshot is created inside the serialized queue turn. Live
    // state changes only after persistence succeeds, so rejection implicitly
    // rolls the mutation back by discarding this draft.
    const snapshot = [...draft.values()].map((device) => ({ ...device }))
    await persist(registryPath, snapshot)
    replaceDevices(draft)
    mutation.commitRuntime?.()
    return mutation.value
  })
}
```

### `initDeviceRegistry` (`server/hub/registry.ts:176-214`) — **exact load/persist idiom**

```ts
/**
 * Point the registry at `<dir>/devices.local.json` and load it. A missing or
 * corrupt file yields an empty registry rather than throwing.
 */
export async function initDeviceRegistry(dir: string): Promise<void> {
  await enqueueRegistryOperation(async () => {
    const nextRegistryPath = join(dir, "devices.local.json")
    const loadedDevices = new Map<string, HubDevice>()

    let raw: string | null = null
    try {
      const contents = await readFile(nextRegistryPath, "utf-8")
      // Existing installations may predate owner-only creation. Refuse to load
      // credentials unless the registry can be repaired to owner-only mode.
      await chmod(nextRegistryPath, 0o600)
      raw = contents
    } catch {
      // Missing file (first run) or unreadable → start empty.
    }

    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const device = normalizeDevice(entry)
            if (device) loadedDevices.set(device.id, device)
          }
        }
      } catch {
        // Corrupt JSON → start empty rather than crashing the shell.
      }
    }

    registryPath = nextRegistryPath
    replaceDevices(loadedDevices)
    runtimes.clear()
  })
}
```

**Callers of `initDeviceRegistry`** (this is where a `initShareRegistry` would be wired):
- `/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/app-server.ts:78` → `await initDeviceRegistry(userDataDir)`
- `/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/api-plugin.ts:31` → `initDeviceRegistry(fileURLToPath(new URL("..", import.meta.url)))` (inside a `Promise.all`-style init list)

### Reads (`server/hub/registry.ts:216-247`)

```ts
// ── Runtime status ───────────────────────────────────────────────────

function getRuntime(id: string): DeviceRuntime {
  return runtimes.get(id) ?? { authState: "unknown" }
}

/** Merge a partial runtime patch for a device into the in-memory status map. */
export function setDeviceRuntime(id: string, patch: Partial<DeviceRuntime>): DeviceRuntime {
  const next: DeviceRuntime = { ...getRuntime(id), ...patch }
  runtimes.set(id, next)
  return next
}

// ── Reads ────────────────────────────────────────────────────────────

/** Full device record including password — for internal (server-side) use only. */
export function getDevice(id: string): HubDevice | undefined {
  return devices.get(id)
}

/**
 * All devices with their runtime status, in insertion (registry) order.
 * NEVER includes the `password` field.
 */
export function listDevices(): PublicDevice[] {
  return [...devices.values()].map((device) => {
    // Explicitly destructure the password out so it can never leak.
    const { password: _password, ...safe } = device
    void _password
    return { ...safe, runtime: getRuntime(device.id) }
  })
}
```

### `addDevice` (`server/hub/registry.ts:249-272`)

```ts
// ── Mutations ────────────────────────────────────────────────────────

export async function addDevice(input: AddDeviceInput): Promise<HubDevice> {
  return commitDeviceMutation((draft) => {
    const device: HubDevice = {
      id: `dev_${randomBytes(8).toString("hex")}`,
      name: input.name,
      host: input.host,
      port: input.port ?? (input.tls ? DEFAULT_TLS_PORT : DEFAULT_PORT),
      tls: input.tls ? true : undefined,
      auth: input.auth,
      password: input.auth === "password" ? input.password : undefined,
      username: input.auth === "password" ? input.username : undefined,
      connectionRevision: 0,
      addedAt: Date.now(),
    }
    draft.set(device.id, device)
    return {
      changed: true,
      value: device,
      commitRuntime: () => runtimes.set(device.id, { authState: "unknown" }),
    }
  })
}
```

### `removeDevice` (`server/hub/registry.ts:334-345`)

```ts
export async function removeDevice(id: string): Promise<boolean> {
  return commitDeviceMutation((draft) => {
    if (!draft.delete(id)) return { changed: false, value: false }
    return {
      changed: true,
      value: true,
      commitRuntime: () => {
        runtimes.delete(id)
      },
    }
  })
}
```

Also present and worth mirroring for share revision/CAS semantics: `sameDeviceConnection` (`:46-55`), `applyDevicePatch` (`:274-289`), `updateDevice` (`:291-312`), `updateDeviceIfConnectionMatches` (`:314-332`).

---

## 3. `server/password-utils.ts` — full exports

Constants (`server/password-utils.ts:5-16`):

```ts
const HASH_PREFIX = "$scrypt$"
const LEGACY_SHA256_PREFIX = "$sha256$"
const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
// OWASP's 16 MiB scrypt profile pairs N=2^14 and r=8 with p=5. This
// preserves a modest desktop memory footprint while meeting its work floor.
const SCRYPT_PARALLELISM = 5
const SCRYPT_KEY_LENGTH = 64
const SCRYPT_MAX_MEMORY = 32 * 1024 * 1024
```

Exported signatures (`server/password-utils.ts:66-152`):

```ts
/** Return true for every password format Cogpit can verify. */
export function isPasswordHashed(stored: string): boolean

/** A versioned value that cannot be parsed must never be treated as plaintext. */
export function isMalformedPasswordHash(stored: string): boolean

/** Successful legacy/plaintext verification should be upgraded to current scrypt. */
export function needsPasswordRehash(stored: string): boolean

/** Hash a password using bounded scrypt parameters encoded into the value. */
export function hashPassword(password: string): string

/** Verify current scrypt hashes plus both historical SHA-256/plaintext formats. */
export function verifyPassword(password: string, stored: string): boolean

/** Async verifier for the public auth path so scrypt never blocks the event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean>
```

Bodies of the two you'll copy verbatim (`server/password-utils.ts:82-92` and `:121-141`):

```ts
/** Hash a password using bounded scrypt parameters encoded into the value. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, Buffer.from(salt, "hex"), SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAX_MEMORY,
  }).toString("hex")
  return `${HASH_PREFIX}${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELISM}$${salt}$${hash}`
}
```

```ts
/** Async verifier for the public auth path so scrypt never blocks the event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const scryptHash = parseScryptHash(stored)
  if (!scryptHash) return verifyPassword(password, stored)

  const candidate = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(scryptHash.salt, "hex"),
      SCRYPT_KEY_LENGTH,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELISM,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => error ? reject(error) : resolve(derivedKey),
    )
  })
  return safeCompareBuffers(candidate, Buffer.from(scryptHash.hash, "hex"))
}
```

Validation block (`server/password-utils.ts:143-152`) — **the entire tail of the file**:

```ts
// ── Password validation ─────────────────────────────────────────────

export const MIN_PASSWORD_LENGTH = 16

export function validatePasswordStrength(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  }
  return null
}
```

### `verifyRemotePassword` — **it is NOT in password-utils.ts**

It is a **module-private function in the config route**, `/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/routes/config.ts:29-43`. It is not exported. A share-login route must either import `verifyPasswordAsync` and re-implement the limiter, or the limiter must be hoisted to a shared module:

```ts
const MAX_CONCURRENT_PASSWORD_VERIFICATIONS = 2
let activePasswordVerifications = 0

async function verifyRemotePassword(
  password: string,
  stored: string,
): Promise<"valid" | "invalid" | "busy"> {
  if (activePasswordVerifications >= MAX_CONCURRENT_PASSWORD_VERIFICATIONS) return "busy"
  activePasswordVerifications += 1
  try {
    return await verifyPasswordAsync(password, stored) ? "valid" : "invalid"
  } finally {
    activePasswordVerifications -= 1
  }
}
```

Companion timing pad, `server/routes/config.ts:45-54`:

```ts
// Logins for unknown users verify against this hash so both outcomes cost one
// scrypt derivation and response timing cannot enumerate usernames. Computed on
// first use: hashing at import time would tax every boot, including personal
// edition, which never reaches this path.
let dummyHash: string | null = null

function getDummyHash(): string {
  dummyHash ??= hashPassword("cogpit-dummy-timing-pad")
  return dummyHash
}
```

Note: routes import these password helpers **through `../helpers`**, not directly (see `server/routes/config.ts:3-20`: `verifyPasswordAsync, needsPasswordRehash, hashPassword, validatePasswordStrength` all come from `"../helpers"`).

---

## 4. `server/security.ts` — verbatim

File is 757 lines. Requested regions below.

### Constants (`server/security.ts:25-42`)

```ts
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

// Defined in ./team/constants so the team modules can share them without
// importing this file back (security.ts imports them — the reverse edge
// would be an import cycle). This module stays their public home.
export { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS }
export type { SessionPrincipal }
```

`SAFE_METHODS` is **module-private** (not exported).

### Loopback / origin helpers (`server/security.ts:44-125`)

```ts
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
```

`isUnforwardedUntrustedLoopback` and `hasSameOrigin` and `requestUsesHttps` are **module-private**. `hasTrustedMutationSource` and `isTrustedDirectLocalRequest` are exported.

### `cookieValue` / `bearerToken` / cookie setters / `canIssueBrowserSession` (`server/security.ts:127-163`)

```ts
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
```

Both `cookieValue` and `bearerToken` are **module-private**; only `getRequestSessionToken` is exported. `setBrowserSessionCookie` uses `res.setHeader` (not `append`) — a share-scoped second cookie would clobber it.

### `safeCompare`, `SessionInfo`, `activeSessions`, revocation (`server/security.ts:240-290`)

```ts
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
  console.error("[team-sessions] Failed to write the persisted session store:", error)
}

/**
 * A live-process invalidation (idle/absolute expiry, UA mismatch, revocation,
 * sweep) must also drop the persisted row, or the team-edition restore path
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
```

`SessionInfo`, `activeSessions`, `notifySessionRevoked` are **module-private**. The public subscriber API is `onSessionRevoked(listener) => unsubscribe`; the listener receives `null` for "all sessions revoked".

### `trackAuthenticatedHttpStream` full body + stream path detection (`server/security.ts:292-352`)

```ts
const HTTP_STREAM_AUTHORIZATION_RECHECK_MS = 5_000

function authenticatedStreamApiPath(rawUrl: string): string | null {
  try {
    const decoded = decodeURIComponent(new URL(rawUrl, "http://cogpit.invalid").pathname)
    const normalized = new URL(decoded, "http://cogpit.invalid").pathname.toLowerCase()
    const hub = /^\/hub\/[^/]+(\/api(?:\/.*)?)$/.exec(normalized)
    return hub?.[1] ?? normalized
  } catch {
    return null
  }
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

/**
 * Bind an authenticated long-lived HTTP response to the session that admitted
 * it. Normal responses unregister on finish; SSE responses are destroyed on
 * logout, disable/demotion/password reset, global revocation, or expiry.
 */
function trackAuthenticatedHttpStream(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): void {
  if (!isAuthenticatedHttpStreamRequest(req)) return

  let cleaned = false
  let timer: ReturnType<typeof setInterval> | null = null
  let unsubscribe = (): void => {}
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    if (timer) clearInterval(timer)
    unsubscribe()
  }
  const terminate = (): void => {
    cleanup()
    if (!res.writableEnded) res.destroy()
  }
  unsubscribe = onSessionRevoked((revokedToken) => {
    if (revokedToken === null || revokedToken === token) terminate()
  })
  timer = setInterval(() => {
    if (!isSessionTokenActive(token)) terminate()
  }, HTTP_STREAM_AUTHORIZATION_RECHECK_MS)
  timer.unref?.()
  res.once("finish", cleanup)
  res.once("close", cleanup)
}
```

`trackAuthenticatedHttpStream` is **module-private**; it is called at `server/security.ts:698` (`authMiddleware`) and `:755` (`teamAuthMiddleware`). **A new SSE endpoint for shares must be added to `isAuthenticatedHttpStreamRequest`'s list**, otherwise the stream is never revoked.

### Session lifecycle exports you'll need (signatures, `server/security.ts:354-534`)

```ts
function discardSession(token: string): Promise<void>          // :354
function discardSessionBestEffort(token: string): void         // :359
export function createSessionToken(ip: string, userAgent?: string, principal?: SessionPrincipal): string  // :363
function getLiveSession(token: string): SessionInfo | null     // :381
function restorePersistedSession(token: string, userAgent: string | undefined): SessionInfo | null  // :402
export function validateSessionToken(token: string, userAgent?: string): boolean   // :430
export function getSessionPrincipal(token: string): SessionPrincipal | null        // :452
export function isSessionTokenActive(token: string): boolean                       // :457
export function revokeSessionToken(token: string): Promise<void>                   // :461
export function revokeAllSessions(): Promise<void>                                 // :465
export function revokeSessionsForUser(userId: string): Promise<void>               // :471
export function __resetSessionsForTest(): void                                     // :481
export function getConnectedDevices(): Array<{ ip: string; userAgent: string; deviceName: string; connectedAt: number; lastActivity: number }>  // :485
```

Auth middleware entry points: `authMiddleware` (`:641`), `teamAuthMiddleware` (`:713`), `PUBLIC_PATHS` (`:626`):

```ts
const PUBLIC_PATHS = new Set(["/api/auth/verify", "/api/hello"])
```

Any share-login endpoint must be added to `PUBLIC_PATHS` (and to `ROUTE_POLICIES` with `requires: "public"`).

---

## 5. `server/helpers.ts` — `isRateLimited`

`/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/helpers.ts:118-169`:

```ts
// ── Rate limiting ────────────────────────────────────────────────────────

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimitMap = new Map<string, RateLimitEntry>()
const RATE_LIMIT_WINDOW_MS = 60_000  // 1 minute
const RATE_LIMIT_MAX_ATTEMPTS = 5    // 5 attempts per window
const RATE_LIMIT_CONNECTOR_MAX_ATTEMPTS = 30

function getRateLimitKey(req: IncomingMessage): string {
  const forwarded = req.headers?.["cf-connecting-ip"] ?? req.headers?.["x-forwarded-for"]
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  const client = value?.split(",")[0]?.trim()
  return client ? `client:${client.slice(0, 128)}` : `socket:${req.socket.remoteAddress || "unknown"}`
}

function consumeRateLimit(key: string, maxAttempts: number, now: number): boolean {
  const entry = rateLimitMap.get(key)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  entry.count += 1
  return entry.count > maxAttempts
}

export function isRateLimited(req: IncomingMessage): boolean {
  const now = Date.now()
  const clientKey = getRateLimitKey(req)
  const socketKey = `socket:${req.socket.remoteAddress || "unknown"}`

  const clientLimited = consumeRateLimit(clientKey, RATE_LIMIT_MAX_ATTEMPTS, now)
  if (clientKey === socketKey) return clientLimited

  // Reverse proxies multiplex many real clients over one connector. Keep a
  // higher connector-wide ceiling so spoofed forwarding headers cannot turn
  // into unlimited password work, without letting one IP lock everybody out.
  const connectorLimited = consumeRateLimit(socketKey, RATE_LIMIT_CONNECTOR_MAX_ATTEMPTS, now)
  return clientLimited || connectorLimited
}

// Periodically clean up expired entries (unref so build process can exit)
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key)
  }
}, 60_000).unref()
```

**Signature:** `isRateLimited(req: IncomingMessage): boolean`. **It consumes a token on every call** (side-effecting), keyed by `cf-connecting-ip`/`x-forwarded-for` first hop, falling back to socket address. 5/min per client, 30/min per socket. There is **no per-resource keying** — a share-token brute-force limiter keyed by share id would need a new counter.

---

## 6. `server/api-routes.ts` — verbatim lines 40-133

`/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/api-routes.ts:40-133` (file is exactly 133 lines):

```ts
import { registerTeamSessionRoutes } from "./routes/team-session"
import { registerTeamRoutes } from "./routes/teams"
import { registerUndoRoutes } from "./routes/undo"
import { registerUsageCostRoutes } from "./routes/usage-cost"
import { registerUsageRoutes } from "./routes/usage"
import { registerWorkflowRoutes } from "./routes/workflows"
import { registerWorktreeRoutes } from "./routes/worktrees"

export interface ApiRouteContext {
  mode: HubMode
}

interface ApiRouteDefinition {
  readonly id: string
  readonly register: (use: UseFn, context: ApiRouteContext) => void
}

function apiRoute(
  id: string,
  register: (use: UseFn) => void,
): ApiRouteDefinition {
  return {
    id,
    register: (use) => register(use),
  }
}

/**
 * Canonical API middleware order shared by Vite, Electron, and standalone.
 *
 * This preserves the original Vite development order. Order is intentional:
 * public device discovery and the hub proxy precede performance monitoring,
 * followed by configuration, domain APIs, and provider runtime controls.
 * Add every new route group here so all server entry points stay in parity.
 */
export const API_ROUTE_REGISTRY = [
  { id: "hello", register: registerHelloRoutes },
  apiRoute("devices", registerDeviceRoutes),
  {
    id: "hub",
    register: (use: UseFn) => use("/hub", createHubProxyHandler()),
  },
  apiRoute("performance", registerPerformanceRoutes),
  apiRoute("config", registerConfigRoutes),
  apiRoute("team-admin", registerTeamAdminRoutes),
  apiRoute("projects", registerProjectRoutes),
  apiRoute("claude", registerClaudeRoutes),
  apiRoute("claude-new", registerClaudeNewRoutes),
  apiRoute("claude-manage", registerClaudeManageRoutes),
  apiRoute("ports", registerPortRoutes),
  apiRoute("teams", registerTeamRoutes),
  apiRoute("team-session", registerTeamSessionRoutes),
  apiRoute("workflows", registerWorkflowRoutes),
  apiRoute("undo", registerUndoRoutes),
  apiRoute("files", registerFileRoutes),
  apiRoute("files-watch", registerFileWatchRoutes),
  apiRoute("session-file-changes", registerSessionFileChangesRoutes),
  apiRoute("session-config", registerSessionConfigRoutes),
  apiRoute("session-context", registerSessionContextRoutes),
  apiRoute("session-status", registerSessionStatusRoutes),
  apiRoute("editor", registerEditorRoutes),
  apiRoute("worktrees", registerWorktreeRoutes),
  apiRoute("usage", registerUsageRoutes),
  apiRoute("usage-cost", registerUsageCostRoutes),
  apiRoute("slash-suggestions", registerSlashSuggestionRoutes),
  apiRoute("config-browser", registerConfigBrowserRoutes),
  apiRoute("local-file", registerLocalFileRoutes),
  apiRoute("file-content", registerFileContentRoutes),
  apiRoute("project-files", registerProjectFileRoutes),
  apiRoute("project-file", registerProjectFileContentRoutes),
  apiRoute("git-status", registerGitStatusRoutes),
  apiRoute("project-icon", registerProjectIconRoutes),
  apiRoute("git-diff", registerGitDiffRoutes),
  apiRoute("mcp", registerMcpRoutes),
  apiRoute("notifications", registerNotificationRoutes),
  apiRoute("scripts", registerScriptRoutes),
  apiRoute("permissions", registerPermissionRoutes),
  apiRoute("mission-control", registerMissionControlRoutes),
  apiRoute("ask-user", registerAskUserRoutes),
  apiRoute("models", registerModelRoutes),
  apiRoute("codex-runtime", registerCodexRuntimeRoutes),
  apiRoute("claude-runtime", registerClaudeRuntimeRoutes),
  apiRoute("provider-updates", registerProviderUpdateRoutes),
] as const satisfies readonly ApiRouteDefinition[]

export function registerApiRoutes(use: UseFn, context: ApiRouteContext): void {
  const safeUse: UseFn = (path, handler) => use(path, catchAsyncErrors(handler))
  // Registered before every route so single-shot JSON/text responses gzip for
  // remote clients (tunnel/LAN); streaming responses pass through untouched.
  safeUse("/api", compressionMiddleware)
  for (const route of API_ROUTE_REGISTRY) {
    route.register(safeUse, context)
  }
}
```

Imports at the top of the same file (`server/api-routes.ts:1-2`):

```ts
import { compressionMiddleware } from "./compression"
import { catchAsyncErrors, type UseFn } from "./http"
```

### `UseFn` / `Middleware` / `NextFn` and `catchAsyncErrors`

`/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/http.ts:4-10`:

```ts
export type NextFn = (err?: unknown) => void
export type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
) => unknown | Promise<unknown>
export type UseFn = (path: string, handler: Middleware) => void
```

`/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/http.ts:122-135`:

```ts
/**
 * Normalize async middleware errors for both Express and Vite's Connect stack.
 * Connect does not observe a returned Promise, so every canonical API handler
 * must explicitly forward rejected work to next(error).
 */
export function catchAsyncErrors(handler: Middleware): Middleware {
  return (req, res, next) => {
    try {
      void Promise.resolve(handler(req, res, next)).catch(next)
    } catch (error) {
      next(error)
    }
  }
}
```

### `readJsonBody` / `withJsonBody` / `sendJson` / `prefixMatches`

`server/http.ts:12-19`:

```ts
const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024

/**
 * Ceiling enforced by the global bodySizeLimit middleware, and the cap a route
 * must opt into to accept a pasted image — DEFAULT_MAX_REQUEST_BODY_BYTES is
 * sized for small JSON.
 */
export const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
```

`server/http.ts:21-40` and `:86-153`:

```ts
export class HttpBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413,
  ) {
    super(message)
    this.name = "HttpBodyError"
  }
}

interface ReadJsonBodyOptions {
  allowEmpty?: boolean
  maxBytes?: number
}

/** Read and parse a bounded JSON request body from a Node HTTP stream. */
export function readJsonBody<T = unknown>(
  req: IncomingMessage,
  options: ReadJsonBodyOptions = {},
): Promise<T> { … }
```

```ts
/**
 * Read a JSON body and hand it to a handler.
 * …
 */
export function withJsonBody<T = unknown>(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (body: T) => void | Promise<void>,
  options: ReadJsonBodyOptions = {},
): void { … }

/** Send a JSON response with the supplied HTTP status. */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(data))
}

/**
 * A prefix only matches at a path-segment boundary: the path equals it, the
 * prefix already ends in "/", or the next character starts a subpath ("/") or
 * query ("?"). Keeps /api/messages from riding an /api/me rule.
 */
export function prefixMatches(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false
  if (path.length === prefix.length || prefix.endsWith("/")) return true
  return path[prefix.length] === "/" || path[prefix.length] === "?"
}
```

---

## 7. Exemplar route modules — the handler idiom

**There is no Express `Router`.** Every route module exports a `register*Routes(use: UseFn)` function that calls `use(prefixPath, middleware)`. Inside the middleware, `req.url` is **already stripped of the mount prefix** (Connect-style path mounting), so `req.url` is the remainder (`"/abc"`, `"/abc/respond"`, `""`, `"?x=1"`).

### `server/routes/session-status.ts` — the ENTIRE file (58 lines)

```ts
import {
  activeProcesses,
  persistentSessions,
  findJsonlPath,
  getSessionStatus,
} from "../helpers"
import { sendJson, type UseFn } from "../http"
import { sdkSessions, isSDKQueryLive } from "../sdk-session"
import { codexAppServer } from "../codex-app-server"

/**
 * In-memory session activity. `live`: the server holds an open query/process
 * that can take follow-ups without a resume (stays true between turns for SDK
 * and legacy sessions). `running`: a turn is in flight right now — set before
 * send-message responds and cleared at the turn boundary, so it is the
 * authoritative completion signal for server-managed sessions, unlike the
 * tail-derived `status`, which lags until the CLI flushes the new turn's JSONL.
 */
function getSessionActivity(sessionId: string): { live: boolean; running: boolean } {
  const sdk = sdkSessions.get(sessionId)
  const persistent = persistentSessions.get(sessionId)
  const codexTurnActive = codexAppServer.getActiveTurnId(sessionId) !== undefined
  return {
    live: isSDKQueryLive(sdk) || Boolean(persistent && !persistent.dead) || codexTurnActive,
    running: sdk?.running === true || activeProcesses.has(sessionId) || codexTurnActive,
  }
}

/**
 * GET /api/session-status/:sessionId — cheap per-session poll for external
 * callers. send-message returns immediately when the SDK query is live, so
 * agents need a way to tell when the turn actually finished: `running` covers
 * sessions this server manages, and the JSONL-tail-derived `status` covers
 * sessions it doesn't (started in a terminal, or before a restart).
 */
export function registerSessionStatusRoutes(use: UseFn) {
  use("/api/session-status/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()

    const sessionId = decodeURIComponent(parts[0])
    try {
      const filePath = await findJsonlPath(sessionId)
      if (!filePath) {
        sendJson(res, 404, { error: "Session not found" })
        return
      }

      const statusInfo = await getSessionStatus(filePath)
      sendJson(res, 200, { sessionId, ...getSessionActivity(sessionId), ...statusInfo })
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })
}
```

**Param parsing idiom:** `new URL(req.url || "/", "http://localhost")` → `pathname.split("/").filter(Boolean)` → length check → `decodeURIComponent(parts[0])`. Alternative idiom used elsewhere: regex on `req.url` — `(req.url ?? "").match(/^\/([^/?]+)$/)` (see claude-manage, permissions).

### `server/routes/config.ts:1-60` (imports + concurrency limiter + issuance helper head)

```ts
import type { IncomingMessage, ServerResponse } from "node:http"
import { HttpBodyError, readJsonBody, type UseFn } from "../http"
import {
  refreshDirs,
  isTrustedDirectLocalRequest,
  hasTrustedMutationSource,
  canIssueBrowserSession,
  isRateLimited,
  createSessionToken,
  getRequestSessionToken,
  setBrowserSessionCookie,
  clearBrowserSessionCookie,
  revokeSessionToken,
  verifyPasswordAsync,
  needsPasswordRehash,
  hashPassword,
  validatePasswordStrength,
  revokeAllSessions,
  getConnectedDevices,
} from "../helpers"
import type { SessionPrincipal } from "../security"
import { isTeamEdition } from "../team/edition"
import { getUserByUsername, withVerifiedUser } from "../team/users"
import { getConfig, getConfiguredEditionValue, saveConfig, validateClaudeDir } from "../config"
import { flushSessionPersistence } from "../team/sessionPersistence"
import { networkInterfaces } from "node:os"
import { resolve } from "node:path"

const MAX_CONCURRENT_PASSWORD_VERIFICATIONS = 2
let activePasswordVerifications = 0

async function verifyRemotePassword(
  password: string,
  stored: string,
): Promise<"valid" | "invalid" | "busy"> {
  if (activePasswordVerifications >= MAX_CONCURRENT_PASSWORD_VERIFICATIONS) return "busy"
  activePasswordVerifications += 1
  try {
    return await verifyPasswordAsync(password, stored) ? "valid" : "invalid"
  } finally {
    activePasswordVerifications -= 1
  }
}

// Logins for unknown users verify against this hash so both outcomes cost one
// scrypt derivation and response timing cannot enumerate usernames. Computed on
// first use: hashing at import time would tax every boot, including personal
// edition, which never reaches this path.
let dummyHash: string | null = null

function getDummyHash(): string {
  dummyHash ??= hashPassword("cogpit-dummy-timing-pad")
  return dummyHash
}

/**
 * Session issuance shared by password login and the first-admin bootstrap.
 * Browser clients get the HttpOnly cookie and never see the token body;
 * machine clients keep the documented bearer-token contract.
 */
```

### Bonus — the exact `/api/auth/verify` login handler a share login must mirror (`server/routes/config.ts:204-308`)

```ts
  // POST /api/auth/verify — public endpoint, validates password and issues session token
  use("/api/auth/verify", async (req, res, next) => {
    if (req.method !== "POST") return next()
    res.setHeader("Content-Type", "application/json")
    res.setHeader("Cache-Control", "no-store")

    // Direct local clients do not need a network password. Requests forwarded
    // by a loopback reverse proxy remain remote and must authenticate below.
    // Team edition never grants local trust — every login names a user.
    if (!isTeamEdition() && isTrustedDirectLocalRequest(req)) {
      res.end(JSON.stringify({ valid: true }))
      return
    }

    if (!hasTrustedMutationSource(req)) {
      res.statusCode = 403
      res.end(JSON.stringify({ valid: false, error: "Untrusted request source" }))
      return
    }

    const browserLogin = req.headers["x-cogpit-client"] === "1"
    if (browserLogin && !canIssueBrowserSession(req)) {
      res.statusCode = 426
      res.end(JSON.stringify({
        valid: false,
        error: "Secure HTTPS is required for remote browser access",
      }))
      return
    }

    // Rate limit remote auth attempts
    if (isRateLimited(req)) {
      res.statusCode = 429
      res.end(JSON.stringify({ valid: false, error: "Too many attempts. Try again in 1 minute." }))
      return
    }

    if (isTeamEdition()) {
      await handleTeamLogin(req, res, browserLogin)
      return
    }
    …
    const verification = await verifyRemotePassword(password, config.networkPassword)
    if (verification === "busy") { res.statusCode = 429; … }
    if (verification === "invalid") { res.statusCode = 401; … }
    …
    // Issue a session token instead of letting client reuse the password
    const sessionToken = createSessionToken(req.socket.remoteAddress || "unknown", req.headers["user-agent"])
    if (browserLogin) {
      setBrowserSessionCookie(res, sessionToken)
      res.end(JSON.stringify({ valid: true }))
    } else {
      // Machine clients cannot use HttpOnly cookies and retain the documented
      // bearer-token contract. Browser callers never receive the token body.
      res.end(JSON.stringify({ valid: true, token: sessionToken }))
    }
  })
```

And issuance (`server/routes/config.ts:61-86`):

```ts
export function issueSessionResponse(
  req: IncomingMessage,
  res: ServerResponse,
  browserLogin: boolean,
  principal?: SessionPrincipal,
): Promise<void> {
  const sessionToken = createSessionToken(
    req.socket.remoteAddress || "unknown",
    req.headers["user-agent"],
    principal,
  )
  return (async () => {
    // A team login is not acknowledged until its hashed session row is on
    // disk. This closes the shutdown race where a successful response could
    // otherwise outlive the process without a restart-restorable session.
    if (principal && isTeamEdition()) await flushSessionPersistence()

    res.setHeader("Content-Type", "application/json")
    if (browserLogin) {
      setBrowserSessionCookie(res, sessionToken)
      res.end(JSON.stringify({ valid: true }))
    } else {
      res.end(JSON.stringify({ valid: true, token: sessionToken }))
    }
  })()
}
```

Session/logout handlers (`server/routes/config.ts:310-329`):

```ts
  // GET /api/auth/session — protected by authMiddleware; lets the browser
  // restore its UI state without exposing the HttpOnly token to JavaScript.
  use("/api/auth/session", (req, res, next) => {
    if (req.method !== "GET") return next()
    res.setHeader("Content-Type", "application/json")
    res.setHeader("Cache-Control", "no-store")
    res.end(JSON.stringify({ authenticated: true }))
  })

  // POST /api/auth/logout — revoke only the current session and expire the
  // browser cookie. Password changes still revoke every session below.
  use("/api/auth/logout", async (req, res, next) => {
    if (req.method !== "POST") return next()
    const token = getRequestSessionToken(req)
    if (token) await revokeSessionToken(token)
    clearBrowserSessionCookie(res)
    res.setHeader("Content-Type", "application/json")
    res.setHeader("Cache-Control", "no-store")
    res.end(JSON.stringify({ valid: true }))
  })
```

---

## 8. `server/team/policy.ts`

Types + helpers (`server/team/policy.ts:1-17`):

```ts
import { prefixMatches } from "../http"

export type PolicyRequirement = "public" | "authed" | "admin"

export interface PolicyRule {
  prefix: string
  methods?: string[]
  requires: PolicyRequirement
}

function authed(...prefixes: string[]): PolicyRule[] {
  return prefixes.map((prefix) => ({ prefix, requires: "authed" }))
}

function admin(...prefixes: string[]): PolicyRule[] {
  return prefixes.map((prefix) => ({ prefix, requires: "admin" }))
}
```

`ROUTE_POLICIES` head, lines 19-70 (**note the method-split example at `devices` and `config`**):

```ts
/**
 * Team-edition access requirements, one entry per id in API_ROUTE_REGISTRY
 * (enforced both ways by api-routes.test.ts). Prefixes mirror the paths each
 * route module actually mounts; requirementFor falls back to "admin" for
 * anything unlisted, so a forgotten path locks down instead of leaking.
 */
export const ROUTE_POLICIES: Record<string, PolicyRule[]> = {
  hello: [{ prefix: "/api/hello", requires: "public" }],
  devices: [
    { prefix: "/api/hub/devices", methods: ["GET"], requires: "authed" },
    { prefix: "/api/hub/devices", requires: "admin" },
  ],
  hub: authed("/hub/"),
  // The bare use("/api", requestMonitor) mount is a pass-through metrics tap,
  // not a request surface — listing it would defeat the fail-safe default.
  performance: [
    ...admin("/api/system-processes"),
    ...authed("/api/performance"),
  ],
  config: [
    { prefix: "/api/config", methods: ["GET"], requires: "authed" },
    { prefix: "/api/config", requires: "admin" },
    ...admin("/api/config/validate"),
    ...authed(
      "/api/network-info",
      "/api/auth/verify",
      "/api/auth/session",
      "/api/auth/logout",
      "/api/connected-devices",
    ),
  ],
  // Longest prefix puts bootstrap above the /api/team/ admin catch-all; the
  // "public" is inert protection — authMiddleware already gates bootstrap by
  // the zero-users window, authz just must not demand a principal for it.
  "team-admin": [
    { prefix: "/api/me", requires: "authed" },
    { prefix: "/api/team/bootstrap", requires: "public" },
    { prefix: "/api/team/", requires: "admin" },
  ],
  projects: authed(
    "/api/projects",
    "/api/codex-subagents",
    "/api/sessions",
    "/api/active-sessions",
    "/api/find-session",
  ),
  claude: authed("/api/send-message"),
  "claude-new": authed(
    "/api/new-session",
    "/api/create-and-send",
    "/api/branch-session",
  ),
```

`requirementFor` (`server/team/policy.ts:166-180`):

```ts
export function requirementFor(path: string, method: string): PolicyRequirement {
  let best: PolicyRule | null = null
  for (const rule of ALL_RULES) {
    if (!prefixMatches(path, rule.prefix)) continue
    if (rule.methods && !rule.methods.includes(method)) continue
    if (
      !best
      || rule.prefix.length > best.prefix.length
      || (rule.prefix.length === best.prefix.length && rule.methods && !best.methods)
    ) {
      best = rule
    }
  }
  return best?.requires ?? "admin"
}
```

Resolution: longest prefix wins; on a tie, the method-specific rule wins; unmatched → `"admin"` (fail closed).

---

## 9. `server/routes/session-config.ts` lines 1-138 (the ENTIRE file)

```ts
import type { IncomingMessage } from "node:http"
import { dirs, findJsonlPath, join, mkdir, readFile, readTranscriptEffort, sendJson } from "../helpers"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { RouteError, sendError, ErrorCodes } from "../lib/routeError"
import type { UseFn } from "../http"

// Per-session UI configuration (model, effort, permission mode, MCP selection …)
// stored server-side so every Cogpit client — any browser, device, or hub-proxied
// remote — sees the same session controls state. Keys are the session fileName
// (session-specific) or the project dirName (project-level fallback for new
// sessions). PUT merges shallowly so independent writers (composer settings,
// MCP selection) never clobber each other's fields.

// No leading dot (rejects "." / ".."), no path separators.
const KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,255}$/

export function isValidSessionConfigKey(key: string): boolean {
  return KEY_PATTERN.test(key)
}

function configFilePath(key: string): string {
  return join(dirs.SESSION_CONFIG_DIR, `${key}.json`)
}

async function readStoredConfig(key: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configFilePath(key), "utf-8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Missing or corrupted file — treat as empty config.
  }
  return {}
}

const SESSION_KEY_SUFFIX = ".jsonl"

/**
 * Fall back to the effort the session last ran at when no client has chosen one.
 * … (doc comment, lines 40-56)
 */
async function withTranscriptEffort(
  key: string,
  stored: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Keys are session fileNames or project dirNames; only the former have a transcript.
  if (!key.endsWith(SESSION_KEY_SUFFIX) || stored.ultracode === true) return stored
  if (typeof stored.effort === "string" && stored.effort) return stored

  try {
    const filePath = await findJsonlPath(key.slice(0, -SESSION_KEY_SUFFIX.length))
    if (!filePath) return stored
    const effort = await readTranscriptEffort(filePath)
    return effort ? { ...stored, effort } : stored
  } catch {
    // An unreadable transcript must not break loading session config.
    return stored
  }
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString()
      if (body.length > 64 * 1024) {
        reject(new RouteError(413, ErrorCodes.INVALID_REQUEST, "Session config payload too large"))
        req.destroy()
      }
    })
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

function parsePatch(body: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid session config JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Session config must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

export function registerSessionConfigRoutes(use: UseFn) {
  use("/api/session-config/", async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()
    const key = decodeURIComponent(parts[0])

    try {
      if (!isValidSessionConfigKey(key)) {
        throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid session config key")
      }

      if (req.method === "GET") {
        return sendJson(res, 200, await withTranscriptEffort(key, await readStoredConfig(key)))
      }

      if (req.method === "PUT" || req.method === "POST") {
        const patch = parsePatch(await collectBody(req))
        await mkdir(dirs.SESSION_CONFIG_DIR, { recursive: true })
        // Shallow merge; a field explicitly set to null is removed.
        const merged = { ...(await readStoredConfig(key)), ...patch }
        for (const [field, value] of Object.entries(merged)) {
          if (value === null) delete merged[field]
        }
        await writeOwnerOnlyJson(configFilePath(key), merged)
        return sendJson(res, 200, merged)
      }

      next()
    } catch (err) {
      if (err instanceof RouteError) return sendError(res, err)
      sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, String(err)))
    }
  })
}
```

**Path derivation:** `dirs.SESSION_CONFIG_DIR` is defined at `/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/config.ts:258`:

```ts
    SESSION_CONFIG_DIR: join(DATA_ROOT, "session-config"),
```

and mirrored into the mutable `dirs` object at `server/sessionPaths.ts:20` / `:64`. A `shares.local.json` written next to `config.local.json` (registry pattern) uses the `initDeviceRegistry(dir)` injection instead.

---

## 10. `server/routes/claude.ts` `/api/send-message` — the whole handler

`/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/routes/claude.ts:1-306` (**the entire file is this one route**). Imports (`:1-27`):

```ts
import {
  activeProcesses,
  persistentSessions,
  findJsonlPath,
  spawn,
  homedir,
  buildCodexPermArgs,
  buildCodexModelArgs,
  buildCodexEffortArgs,
  buildCodexFastModeArgs,
  writeTempImageFiles,
  cleanupTempFiles,
  getAgentKindFromSessionPath,
  getSessionMeta,
  friendlySpawnError,
} from "../helpers"
import type { UseFn } from "../http"
import type { PersistentSession } from "../helpers"
import { buildStreamMessage as buildClaudeStreamMessage, CODEX_IMAGE_ONLY_PROMPT } from "../lib/streamMessage"
import { sdkSessions, sendSDKMessage, resumeSDKSession, attachSubagentWatcher, isSDKQueryLive } from "../sdk-session"
import { RouteError, sendError, ErrorCodes } from "../lib/routeError"
import { resolveAgentCommand } from "../lib/binaryResolver"
import { codexAppServer } from "../codex-app-server"
import {
  continueCodexExecution,
  isCodexAppServerUnavailable,
} from "../lib/codexExecution"
```

Handler entry + body parse + session resolution (`server/routes/claude.ts:29-56`):

```ts
export function registerClaudeRoutes(use: UseFn) {
  use("/api/send-message", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", async () => {
      try {
        const { sessionId, message, images, cwd, permissions, model, effort, fastMode, ultracode, mcpConfig } = JSON.parse(body)

        if (!sessionId || (!message && (!images || images.length === 0))) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "sessionId and message or images are required"))
          return
        }

        const existing = persistentSessions.get(sessionId)
        const sessionPath = existing?.jsonlPath ?? await findJsonlPath(sessionId)
        const agentKind = existing?.agentKind ?? getAgentKindFromSessionPath(sessionPath)
```

**What it does with `sessionId` — the four branches:**

1. **Codex branch** (`:50-189`): if `agentKind === "codex"`, rejects with 409 if `persistentSessions.get(sessionId)` is alive; else `await continueCodexExecution(codexAppServer, sessionId, { cwd, message, images, permissions, model, effort, fastMode })`; falls back to spawning `codex exec … resume … <sessionId>` and registering `persistentSessions.set(sessionId, ps)` + `activeProcesses.set(sessionId, child)`.

2. **Live SDK branch** (`:191-216`):

```ts
        // Check for an existing SDK session first
        const existingSDK = sdkSessions.get(sessionId)

        if (isSDKQueryLive(existingSDK)) {
          // SDK query is alive — enqueue the message on its persistent input
          // stream. A turn result can arrive while background workflows are
          // still running, so `running` alone is not a process-liveness check.
          // Forward the latest model/effort/mcpConfig so both the live query
          // and any subsequent restart see fresh values.
          const state = sendSDKMessage(sessionId, message, images, {
            model,
            effort,
            fastMode,
            ultracode,
            mcpConfig,
          })
          if (!state) {
            sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, "Failed to send message to running session"))
            return
          }
          // The message was injected into the live stream — respond immediately.
          // The frontend watches the JSONL for real-time progress.
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ success: true }))
          return
        }
```

3. **Legacy CLI persistent branch** (`:218-248`):

```ts
        // Fallback: check for old-style persistent session (CLI-spawned)
        const legacyPs = persistentSessions.get(sessionId)
        if (legacyPs && !legacyPs.dead) {
          const streamMsg = buildClaudeStreamMessage(message, images)
          activeProcesses.set(sessionId, legacyPs.proc)
          let responded = false
          legacyPs.onResult = (result) => {
            if (responded) return
            responded = true
            activeProcesses.delete(sessionId)
            legacyPs.onResult = null
            res.setHeader("Content-Type", "application/json")
            if (result.is_error) {
              sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, result.result || "Claude returned an error"))
            } else {
              res.end(JSON.stringify({ success: true }))
            }
          }
          const onDeath = () => {
            if (responded) return
            responded = true
            activeProcesses.delete(sessionId)
            legacyPs.onResult = null
            sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, "Claude process died unexpectedly"))
          }
          legacyPs.proc.once("close", onDeath)
          legacyPs.proc.stdin?.write(streamMsg + "\n")
          return
        }

        if (legacyPs) persistentSessions.delete(sessionId)
```

4. **SDK resume branch** (`:250-305`):

```ts
        // Resume via Agent SDK — start a new query with resume.
        // Claude Code scopes --resume to the project directory derived from
        // cwd, so when the client omits cwd we must recover it from the
        // session's own metadata or the resume won't find the session.
        const resumeMeta = !cwd && sessionPath
          ? await getSessionMeta(sessionPath).catch(() => null)
          : null
        const sdkState = resumeSDKSession({
          sessionId,
          cwd: cwd || resumeMeta?.cwd || homedir(),
          message,
          images,
          permissionMode: permissions?.mode,
          allowedTools: permissions?.allowedTools,
          disallowedTools: permissions?.disallowedTools,
          model,
          effort,
          fastMode,
          ultracode,
          mcpConfig,
        })

        // Attach the sub-agent watcher so progress streams in real-time
        if (sessionPath) {
          sdkState.jsonlPath = sessionPath
          attachSubagentWatcher(sdkState)
        } else {
          findJsonlPath(sessionId).then((p) => {
            if (p) {
              sdkState.jsonlPath = p
              attachSubagentWatcher(sdkState)
            }
          })
        }

        let responded = false
        sdkState.onResult = (result) => {
          if (responded) return
          responded = true
          sdkState.onResult = null
          res.setHeader("Content-Type", "application/json")
          if ((result as Record<string, unknown>).is_error) {
            const { result: errResult, subtype } = result as Record<string, unknown>
            const errorMessage = errResult != null
              ? String(errResult)
              : `Claude returned an error${subtype ? ` (${subtype})` : ""}`
            sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, errorMessage))
          } else {
            res.end(JSON.stringify({ success: true }))
          }
        }
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
      }
    })
  })
}
```

**Delegation note for a share-scoped wrapper:** the handler takes `sessionId` **only from the JSON body**, never from the URL. It reads the raw stream itself (`req.on("data")`), so a wrapper cannot simply re-call the handler after consuming the body — it must either (a) mount before `/api/send-message` and authorize by inspecting the body, or (b) factor a `sendMessageToSession(params)` function out of the `req.on("end")` closure.

---

## 11. `server/routes/claude-manage.ts` — stop + interrupt

Shared body collector (`server/routes/claude-manage.ts:27-49`):

```ts
function collectRequestBody(
  req: IncomingMessage,
  handleBody: (body: string) => void | Promise<void>,
): void {
  let body = ""
  req.on("data", (chunk: Buffer | string) => { body += chunk.toString() })
  req.on("end", () => { void handleBody(body) })
}

function terminatePersistentSession(sessionId: string): boolean {
  const session = persistentSessions.get(sessionId)
  if (!session) return false
  if (session.dead) return true

  session.dead = true
  session.proc.kill("SIGTERM")
  persistentSessions.delete(sessionId)
  const forceKill = setTimeout(() => {
    try { session.proc.kill("SIGKILL") } catch { /* already dead */ }
  }, 3000)
  forceKill.unref()
  return true
}
```

`/api/interrupt-session` (`server/routes/claude-manage.ts:68-86`):

```ts
  use("/api/interrupt-session", (req, res, next) => {
    if (req.method !== "POST") return next()
    collectRequestBody(req, async (body) => {
      try {
        const { sessionId } = JSON.parse(body)
        if (!sessionId) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "sessionId is required"))
          return
        }
        const activeCodexTurnId = codexAppServer.getActiveTurnId(sessionId)
        const interrupted = activeCodexTurnId
          ? await codexAppServer.interruptTurn(sessionId, activeCodexTurnId).then(() => true)
          : await interruptSDKTurn(sessionId)
        sendJson(res, 200, { success: interrupted })
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
      }
    })
  })
```

`/api/stop-session` (`server/routes/claude-manage.ts:146-196`):

```ts
  use("/api/stop-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    collectRequestBody(req, async (body) => {
      try {
        const { sessionId } = JSON.parse(body)

        if (!sessionId) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "sessionId is required"))
          return
        }

        let stoppedNativeCodex = false
        const activeCodexTurnId = codexAppServer.getActiveTurnId(sessionId)
        if (activeCodexTurnId) {
          try {
            await codexAppServer.interruptTurn(sessionId, activeCodexTurnId)
            stoppedNativeCodex = true
          } catch {
            // Fall through to the legacy process controls below. This keeps
            // stop working with older CLIs and during app-server restarts.
          }
        }

        // Stop SDK session if present
        const stoppedSDK = stopSDKSession(sessionId)

        const hadPersistentSession = terminatePersistentSession(sessionId)

        const child = activeProcesses.get(sessionId)
        if (!child && !hadPersistentSession && !stoppedSDK && !stoppedNativeCodex) {
          sendJson(res, 200, { success: false, error: "No active process for this session" })
          return
        }

        if (child) {
          child.kill("SIGTERM")
          const forceKill = setTimeout(() => {
            if (activeProcesses.has(sessionId)) {
              child.kill("SIGKILL")
            }
          }, 3000)
          forceKill.unref()
        }

        sendJson(res, 200, { success: true })
      } catch {
        sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid JSON body"))
      }
    })
  })
```

Both take `sessionId` **from the JSON body**.

---

## 12. Permission approval + ask-user

### `server/routes/permissions.ts` — route registration and handlers (`:231-482`)

Registration signature takes an injectable codex client (used by tests):

```ts
export function registerPermissionRoutes(
  use: UseFn,
  codex: CodexApprovalClient = codexAppServer,
) {
  use("/api/permissions", (req, res, next) => {
    const url = req.url ?? ""

    // GET /api/permissions — every pending request, grouped by session. Powers
    // the Mission Control grid, which must surface requests for sessions that
    // are not open.
    if (req.method === "GET" && (url === "" || url === "/" || url.startsWith("?"))) {
      const bySession: Record<string, MissionControlPermission[]> = {}
      for (const sessionId of listPermissionSessionIds(codex)) {
        const permissions = collectPendingPermissions(sessionId, codex)
        if (permissions.length > 0) {
          bySession[sessionId] = permissions.map((r) => summarizeRequest(sessionId, r))
        }
      }
      sendJson(res, 200, { bySession })
      return
    }

    // GET /api/permissions/:sessionId — return pending permission requests
    const getMatch = url.match(/^\/([^/?]+)$/)
    if (req.method === "GET" && getMatch) {
      const sessionId = decodeURIComponent(getMatch[1])
      sendJson(res, 200, { permissions: collectPendingPermissions(sessionId, codex) })
      return
    }

    // POST /api/permissions/:sessionId/respond — approve/deny a single tool
    const respondMatch = url.match(/^\/([^/?]+)\/respond$/)
    if (req.method === "POST" && respondMatch) {
      const sessionId = decodeURIComponent(respondMatch[1])
      let body = ""
      req.on("data", (chunk: string) => { body += chunk })
      req.on("end", async () => {
        try {
          const { requestId, behavior } = JSON.parse(body)

          if (typeof requestId !== "string" || !requestId) {
            sendJson(res, 400, { error: "requestId is required" })
            return
          }
          if (behavior !== "allow" && behavior !== "allow_always" && behavior !== "deny") {
            sendJson(res, 400, { error: "behavior must be 'allow', 'allow_always', or 'deny'" })
            return
          }

          // SDK session path: resolves the canUseTool promise directly
          if (sdkSessions.has(sessionId)) {
            const result = resolvePermission(sessionId, requestId, behavior)
            if (!result.found) {
              sendJson(res, 404, { error: "Permission request not found or already resolved" })
              return
            }
            sendJson(res, 200, {
              success: true,
              action: behavior === "deny" ? "denied" : "allowed",
              toolName: result.toolName,
            })
            return
          }

          const codexApproval = findCodexApproval(codex, sessionId, requestId)
          if (codexApproval) {
            const decision = behavior as ApprovalDecision
            if (!codexApproval.availableDecisions.includes(decision)) {
              sendUnavailableDecision(res, codexApproval, decision)
              return
            }
            try {
              await codex.respondApproval(codexApproval, decision)
            } catch (error) {
              sendCodexApprovalError(res, error)
              return
            }
            const permission = normalizeCodexApproval(codexApproval)
            sendJson(res, 200, {
              success: true,
              action: behavior === "deny" ? "denied" : "allowed",
              toolName: permission.toolName,
              shouldRetry: false,
            })
            return
          }

          // Fallback: legacy CLI session (kill + retry approach)
          const ps = persistentSessions.get(sessionId)
          if (!ps) {
            sendJson(res, 404, { error: "Session not found" })
            return
          }

          const permReq = ps.pendingPermissions.get(requestId)
          if (!permReq) {
            sendJson(res, 404, { error: "Permission request not found or already resolved" })
            return
          }

          ps.pendingPermissions.delete(requestId)

          if (behavior === "deny") {
            sendJson(res, 200, { success: true, action: "denied" })
            return
          }

          const toolName = permReq.toolName
          const hasAlready = ps.permArgs.some(
            (a, i) => a === "--allowedTools" && ps.permArgs[i + 1] === toolName
          )
          if (!hasAlready) {
            ps.permArgs = [...ps.permArgs, "--allowedTools", toolName]
          }

          if (ps.pendingPermissions.size === 0) {
            if (!ps.dead) {
              ps.dead = true
              try { ps.proc.kill("SIGTERM") } catch { /* already dead */ }
              activeProcesses.delete(sessionId)
            }
            sendJson(res, 200, { success: true, action: "allowed", shouldRetry: true, toolName })
          } else {
            sendJson(res, 200, { success: true, action: "allowed", shouldRetry: false, toolName })
          }
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" })
        }
      })
      return
    }

    // POST /api/permissions/:sessionId/respond-all — batch approve/deny
    const respondAllMatch = url.match(/^\/([^/?]+)\/respond-all$/)
    if (req.method === "POST" && respondAllMatch) {
      const sessionId = decodeURIComponent(respondAllMatch[1])
      let body = ""
      req.on("data", (chunk: string) => { body += chunk })
      req.on("end", async () => {
        try {
          const { behavior } = JSON.parse(body)

          if (behavior !== "allow" && behavior !== "allow_always" && behavior !== "deny") {
            sendJson(res, 400, { error: "behavior must be 'allow', 'allow_always', or 'deny'" })
            return
          }

          // SDK session path
          if (sdkSessions.has(sessionId)) {
            const toolNames = resolveAllPermissions(sessionId, behavior)
            sendJson(res, 200, {
              success: true,
              action: behavior === "deny" ? "denied" : "allowed",
              count: toolNames.length,
              toolNames,
            })
            return
          }

          const codexPending = codex.listPendingApprovals(sessionId)
          if (codexPending.length > 0) {
            const requestedDecision = behavior as ApprovalDecision
            const decisions: Array<{
              approval: PendingApproval
              decision: ApprovalDecision
            }> = []
            for (const approval of codexPending) {
              const decision = selectCodexBatchDecision(
                approval,
                requestedDecision,
              )
              if (!decision) {
                sendUnavailableDecision(res, approval, requestedDecision)
                return
              }
              decisions.push({ approval, decision })
            }
            try {
              await Promise.all(
                decisions.map(({ approval, decision }) =>
                  codex.respondApproval(approval, decision),
                ),
              )
            } catch (error) {
              sendCodexApprovalError(res, error)
              return
            }
            const toolNames = [
              ...new Set(
                codexPending.map(
                  (approval) => normalizeCodexApproval(approval).toolName,
                ),
              ),
            ]
            sendJson(res, 200, {
              success: true,
              action: behavior === "deny" ? "denied" : "allowed",
              count: codexPending.length,
              toolNames,
              shouldRetry: false,
            })
            return
          }

          // Fallback: legacy CLI session
          const ps = persistentSessions.get(sessionId)
          …
        } catch {
          sendJson(res, 400, { error: "Invalid JSON body" })
        }
      })
      return
    }

    next()
  })
}
```

Exported helpers on the same module (`server/routes/permissions.ts:13-16, 33-35, 160-194`):

```ts
export type CodexApprovalClient = Pick<
  CodexAppServer,
  "listPendingApprovals" | "respondApproval" | "listApprovalThreadIds"
>

export function normalizeCodexApproval(approval: PendingApproval): FrontendPermissionRequest

export function collectPendingPermissions(
  sessionId: string,
  codex: CodexApprovalClient = codexAppServer,
): FrontendPermissionRequest[] | ReturnType<typeof getSDKPermissions>

export function listPermissionSessionIds(
  codex: CodexApprovalClient = codexAppServer,
): string[]
```

**Keying:** `sessionId` comes from the **URL path** (`/api/permissions/:sessionId/respond`), `requestId` + `behavior` from the body. Behavior values: `"allow" | "allow_always" | "deny"`.

### `server/routes/ask-user.ts` — the ENTIRE file (87 lines)

```ts
import {
  sdkSessions,
  resolveUserQuestion,
  getSDKUserQuestions,
  listUserQuestionSessionIds,
  type UserQuestionAnswers,
} from "../sdk-session"
import { sendJson, type UseFn, withJsonBody} from "../http"
import type { MissionControlQuestion } from "../../shared/contracts/missionControl"

export function registerAskUserRoutes(use: UseFn) {
  /**
   * GET /api/user-questions — every AskUserQuestion call currently blocking a
   * session, grouped by session.
   *
   * Read from the live resolver map rather than from transcripts on purpose: a
   * session whose server restarted still has the tool call in its JSONL forever,
   * so a transcript-derived list would claim abandoned sessions are waiting on
   * the user. Being listed here means the question can actually be answered.
   */
  use("/api/user-questions", (req, res, next) => {
    if (req.method !== "GET") {
      next()
      return
    }
    const bySession: Record<string, MissionControlQuestion[]> = {}
    for (const sessionId of listUserQuestionSessionIds()) {
      const questions = getSDKUserQuestions(sessionId)
      if (questions.length > 0) bySession[sessionId] = questions
    }
    sendJson(res, 200, { bySession })
  })

  use("/api/ask-user-answer", (req, res, next) => {
    if (req.method !== "POST") {
      next()
      return
    }

    withJsonBody<{
      sessionId?: unknown
      toolUseId?: unknown
      answers?: unknown
    }>(req, res, (parsed) => {
      try {
        const { sessionId, toolUseId, answers } = parsed

        if (!sessionId || typeof sessionId !== "string") {
          sendJson(res, 400, { error: "sessionId is required" })
          return
        }
        if (!toolUseId || typeof toolUseId !== "string") {
          sendJson(res, 400, { error: "toolUseId is required" })
          return
        }
        if (answers === undefined || answers === null) {
          sendJson(res, 400, { error: "answers is required" })
          return
        }

        if (!sdkSessions.has(sessionId)) {
          sendJson(res, 404, { error: "Session not found or not a live SDK session" })
          return
        }

        if (
          typeof answers !== "string" &&
          !Array.isArray(answers) &&
          (typeof answers !== "object" || answers === null)
        ) {
          sendJson(res, 400, { error: "answers must be an array or object" })
          return
        }

        const result = resolveUserQuestion(sessionId, toolUseId, answers as UserQuestionAnswers)
        if (!result.found) {
          sendJson(res, 404, { error: "Question not found or already answered" })
          return
        }

        sendJson(res, 200, { ok: true })
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" })
      }
    })
  })
}
```

**Keying:** `sessionId` + `toolUseId` from the **JSON body** (via `withJsonBody`, the modern idiom). SDK-only — no Codex/legacy fallback.

---

## 13. `src/main.tsx` + `src/components/DeviceRoot.tsx`

`/Users/gentritbiba/agent-window/.worktrees/session-sharing/src/main.tsx:1-16` (**the entire file**):

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { DeviceRoot } from './components/DeviceRoot.tsx'
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element not found')

createRoot(rootEl).render(
  <StrictMode>
    <AppErrorBoundary>
      <DeviceRoot />
    </AppErrorBoundary>
  </StrictMode>,
)
```

There is **one entry point, one root render, no router**. A share route (`/s/:token`) must branch either inside `main.tsx` before `<DeviceRoot />` or inside `DeviceRoot` itself.

`/Users/gentritbiba/agent-window/.worktrees/session-sharing/src/components/DeviceRoot.tsx:1-70`:

```tsx
import { useCallback, useEffect, useState } from "react"
import { WifiOff, Loader2 } from "lucide-react"
import App from "@/App"
import {
  getActiveDeviceId,
  getActiveIdentity,
  getDeviceConnectionRevision,
  switchDevice,
  LOCAL_DEVICE_ID,
} from "@/lib/device"
import { matchDeviceSwitchIndex, matchDeviceCycle } from "@/lib/keybindings"
import { revealSessionPath } from "@/lib/revealSession"
import { useDevices } from "@/hooks/useDevices"
import { SessionInventoryProvider } from "@/contexts/SessionInventoryContext"
import { PendingHumanInputProvider } from "@/contexts/PendingHumanInputContext"
import { Button } from "@/components/ui/button"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"

/**
 * Owns the active device identity and remounts the whole {@link App} subtree
 * (via a React `key`) whenever the active device changes.
 *
 * A keyed remount tears down every App-level hook: PTY sockets, session
 * subscriptions, in-flight fetches. Switching devices therefore starts from a
 * clean slate instead of leaking one device's live state into another. Module
 * caches survive the remount but are device-scoped by key (see sessionCache /
 * sessionPrefetch / useSessionHistory / usePermissions), so a switch-back stays
 * warm without cross-device collisions.
 *
 * The device id is derived from the URL ("/d/:id/..." → id, else "local"). We
 * re-derive on `cogpit-device-changed` (explicit switchDevice) and on `popstate`
 * (back/forward across a device boundary), updating state only when the id
 * actually changes so intra-device navigation never forces a remount.
 *
 * The key also carries the signed-in team identity (`cogpit-identity-changed`,
 * dispatched by setActiveIdentity when useMe settles /api/me): login, logout,
 * and user switches remount App so every mount-time storage read (usePermissions,
 * useSessionHistory, useLocalStorage consumers) re-runs through the
 * identity-scoped deviceScopedKey. Personal edition never dispatches — no
 * remount, no hold, boot behavior is byte-identical to pre-team builds.
 *
 * Also hosted here because they must survive the remount:
 * - device keyboard shortcuts (platform chord 1..9 jump, platform chord 0 cycle)
 * - the offline banner for an unreachable active remote device
 *
 * The session inventory provider is keyed here rather than inside App so the
 * sidebar and Mission Control share one poll, scoped to the active device.
 */
export function DeviceRoot() {
  const [activeDeviceId, setActiveDeviceId] = useState(getActiveDeviceId)
  const [connectionRevision, setConnectionRevision] = useState(
    () => getDeviceConnectionRevision(getActiveDeviceId()),
  )
  const [identityKey, setIdentityKey] = useState(getActiveIdentity)
  const [retryNonce, setRetryNonce] = useState(0)
  const [unreachable, setUnreachable] = useState(false)
  const [badPassword, setBadPassword] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const { devices, testDevice } = useDevices()

  useEffect(() => {
    const sync = () => {
      const next = getActiveDeviceId()
      setActiveDeviceId((prev) => (prev === next ? prev : next))
      setConnectionRevision(getDeviceConnectionRevision(next))
    }
```

URL scheme precedent: **`/d/:deviceId/...`** parsed by `getActiveDeviceId()` in `@/lib/device`, with `withBase()` re-prefixing `/api/*` calls.

---

## 14. `src/lib/auth.ts`

`getServerHello` and friends (`/Users/gentritbiba/agent-window/.worktrees/session-sharing/src/lib/auth.ts:35-101`):

```ts
// ── Server handshake (public /api/hello) ────────────────────────────────

/** The pre-authentication facts the renderer needs from `/api/hello`. */
export interface ServerHello {
  edition: CogpitEdition
  /** Team server with no accounts yet: the first-admin screen is open. */
  needsBootstrap: boolean
}

const PERSONAL_HELLO: ServerHello = { edition: "personal", needsBootstrap: false }

let helloPromise: Promise<ServerHello> | null = null
let knownEdition: CogpitEdition | null = null

function probeServerHello(): Promise<ServerHello> {
  return fetch("/api/hello", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-Cogpit-Client": "1" },
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Hello handshake failed (${res.status})`)
      const data = await res.json() as { edition?: unknown; needsBootstrap?: unknown }
      knownEdition = data.edition === "team" ? "team" : "personal"
      return {
        edition: knownEdition,
        needsBootstrap: knownEdition === "team" && data.needsBootstrap === true,
      }
    })
    .catch(() => {
      helloPromise = null
      return PERSONAL_HELLO
    })
}

/**
 * Resolve the public `/api/hello` handshake — needed BEFORE authentication
 * because a team server gates even localhost browsers and may have no accounts
 * to log into yet. Fetched once and shared by every consumer (auth gate, login
 * screen, bootstrap screen); a failed probe resolves as personal (the no-op
 * path) without being cached so the next caller retries.
 */
export function getServerHello(): Promise<ServerHello> {
  helloPromise ??= probeServerHello()
  return helloPromise
}

/**
 * Re-run the handshake and replace the cache. Bootstrap state changes the
 * moment the first admin is created — by this browser or another one — so the
 * cached answer must be discarded rather than trusted for the session.
 */
export function refreshServerHello(): Promise<ServerHello> {
  helloPromise = probeServerHello()
  return helloPromise
}

/** The server edition alone, from the same shared handshake. */
export function getServerEdition(): Promise<CogpitEdition> {
  return getServerHello().then((hello) => hello.edition)
}

export function __resetServerHelloForTest(): void {
  helloPromise = null
  knownEdition = null
}
```

`requestWithAuth` / `authFetch` / `hubFetch` / `authUrl` (`src/lib/auth.ts:133-222` — **the tail of the file**):

```ts
/** Scrub legacy tokens, announce the login requirement, and fail the call. */
function failAuthRequired(): Promise<never> {
  clearToken()
  window.dispatchEvent(new Event("cogpit-auth-required"))
  return Promise.reject(new Error("Authentication required"))
}

/**
 * Shared fetch core for {@link authFetch} and {@link hubFetch}.
 *
 * - Always sends `X-Cogpit-Client: 1` (drive-by-localhost CSRF guard; the hub
 *   requires it on state-changing `/hub/*` requests).
 * - Browser credentials stay in an HttpOnly same-origin cookie. A gated 401
 *   emits `cogpit-auth-required`; JavaScript never reads or attaches the token.
 * - A local 401 while the edition is still unknown (the boot hello probe
 *   failed) re-probes once — a team server then gates this tab instead of
 *   leaving it permanently on raw errors.
 * - A `502` carrying `X-Cogpit-Device` means the hub could not reach that remote
 *   device; dispatch `cogpit-device-unreachable` (banner signal) and still
 *   return the response.
 *
 * @param applyBase when true and `input` is a string starting "/api", route it
 *   to the active device via {@link withBase}. `hubFetch` passes false so
 *   hub-scoped calls always target the hub itself.
 */
function requestWithAuth(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  applyBase: boolean,
): Promise<Response> {
  if (applyBase && typeof input === "string" && input.startsWith("/api")) {
    input = withBase(input)
  }

  const headers = new Headers(init?.headers)
  headers.delete("Authorization")
  headers.set("X-Cogpit-Client", "1")

  return fetch(input, { ...init, headers, credentials: "same-origin" }).then((res) => {
    if (res.status === 401) {
      // A 401 means "session required" for remote clients always, and for local
      // browsers once the server is known to be team edition (team gates localhost).
      if (isRemoteClient() || knownEdition === "team") return failAuthRequired()
      // Unknown edition on a local client means the hello probe failed and
      // "personal" was assumed without being cached — re-probe before trusting
      // the assumption (a failed probe leaves no cache, so this fetches fresh).
      if (knownEdition === null) {
        return getServerEdition().then((edition) =>
          edition === "team" ? failAuthRequired() : res,
        )
      }
    }
    if (res.status === 502) {
      const deviceId = res.headers.get("X-Cogpit-Device")
      if (deviceId) {
        window.dispatchEvent(
          new CustomEvent("cogpit-device-unreachable", { detail: { deviceId } }),
        )
      }
    }
    return res
  })
}

/**
 * Wrapper around fetch that includes the browser session cookie and routes
 * string `/api/*` URLs to the active device. The `X-Cogpit-Client` header is
 * always present as the mutation-source guard.
 */
export function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return requestWithAuth(input, init, true)
}

/**
 * Like {@link authFetch} but never applies the device prefix — for hub-scoped
 * call sites (device management, hub network info) that must always target the
 * hub itself regardless of the active device.
 */
export function hubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return requestWithAuth(input, init, false)
}

/**
 * Route URLs to the active device. EventSource, images, and WebSockets receive
 * the same-origin HttpOnly cookie automatically, so credentials never enter
 * query strings.
 */
export function authUrl(url: string): string {
  return withBase(url)
}
```

Head of the file (`src/lib/auth.ts:1-33`) — `isRemoteClient`, `clearToken`, the module-load token scrub:

```ts
// ── Network auth utilities ──────────────────────────────────────────────

import { withBase } from "./device"
import type { CogpitEdition } from "../../shared/contracts/team"

const LEGACY_TOKEN_KEY = "cogpit-network-token"
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1",
])

export function isRemoteClient(): boolean { … }
export function clearToken(): void { … }

// Remove tokens written by older releases as soon as the hardened client
// loads. Session credentials must never be readable by page JavaScript.
if (typeof window !== "undefined") clearToken()
```

Also exported: `checkAuthSession(): Promise<boolean>` (`:103`), `logoutSession(): Promise<void>` (`:120`).

---

## 15. `src/components/FloatingChrome.tsx` — where a Share button goes

Props interface (`src/components/FloatingChrome.tsx:57-96`):

```tsx
interface FloatingChromeProps {
  /** Whether the sidebar is toggled on — decides if the expand pill is offered. */
  showSidebar: boolean
  /**
   * Whether a sidebar is actually on screen. Config view replaces it with its
   * own rail, and without a sidebar the pills have to clear the traffic lights
   * themselves.
   */
  sidebarRendered?: boolean
  sidebarShortcut: string
  showStats: boolean
  showWorktrees?: boolean
  showFileChanges?: boolean
  hasFileChanges?: boolean
  killing: boolean
  creatingSession: boolean
  onNewSession: (dirName: string, cwd?: string) => void
  onDuplicateSession?: () => void
  onOpenTerminal?: () => void
  onBackToMain?: () => void
  onShowWorkflows?: () => void
  workflowCount?: number
  onToggleSidebar: () => void
  onToggleStats: () => void
  onToggleWorktrees?: () => void
  onToggleFileChanges?: () => void
  onKillAll: () => void
  onOpenSettings: () => void
  showConfig?: boolean
  onToggleConfig?: () => void
  showMission?: boolean
  onToggleMission?: () => void
}

const PILL_ROW = "flex h-8 items-center px-0.5"

/**
 * Everything that used to live in the top bar, floating over the chat pane:
 * session pill on the left, status pills and the overflow menu on the right.
 * Content scrolls underneath; the pane reserves its own top padding.
 */
export const FloatingChrome = memo(function FloatingChrome({
```

Context/hook consumption + derived values (`src/components/FloatingChrome.tsx:125-157`):

```tsx
  const { config: { networkUrl, defaultAgentKind } } = useAppContext()
  const { session, sessionSource, isLive } = useSessionContext()
  const inventory = useSessionInventoryOptional()
  const canViewUsage = useCapability("viewUsage")
  const [usageOpen, setUsageOpen] = useState(false)
  const [monitorOpen, setMonitorOpen] = useState(false)
  const [cmdCopied, copyCmd] = useCopyWithFeedback()

  const sessionTurns = session?.turns
  const scanned = inventory?.sessions.find(
    (candidate) => candidate.sessionId === session?.sessionId,
  )?.pullRequests
  const pullRequests = useMemo(
    () => mergePullRequests(extractPullRequests(sessionTurns ?? []), scanned),
    [sessionTurns, scanned],
  )
  const activeAgentKind = sessionSource
    ? sessionSource.agentKind ?? agentKindFromDirName(sessionSource.dirName)
    : defaultAgentKind
  const isSubAgent = sessionSource ? parseSubAgentPath(sessionSource.fileName) !== null : false

  function handleCopyResumeCmd(): void {
    if (!session) return
    const agentKind = sessionSource?.agentKind ?? agentKindFromDirName(sessionSource?.dirName ?? null)
    copyCmd(getResumeCommand(agentKind, session.sessionId, session.cwd))
  }

  function handleCopyNetworkUrl(): void {
    if (!networkUrl) return
    void copyToClipboard(networkUrl).then((ok) => {
      if (ok) toast.success("Copied network URL")
    })
  }
```

`session.sessionId`, `session.cwd`, `sessionSource.dirName`, `sessionSource.fileName` are all available for building a share payload.

The ⋯ dropdown, `src/components/FloatingChrome.tsx:243-343` (verbatim):

```tsx
          <div className={cn(FLOATING_PILL, PILL_ROW)}>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
              >
                <MoreHorizontal data-icon="inline-start" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="w-64">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Workspace</DropdownMenuLabel>
                  {onToggleMission && (
                    <DropdownMenuItem onClick={onToggleMission}>
                      <LayoutGrid />
                      Mission Control
                      {showMission && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {onToggleConfig && (
                    <DropdownMenuItem onClick={onToggleConfig}>
                      <SlidersHorizontal />
                      Config
                      {showConfig && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {onToggleWorktrees && (
                    <DropdownMenuItem onClick={onToggleWorktrees}>
                      <GitBranch />
                      Worktrees
                      {showWorktrees && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {hasFileChanges && onToggleFileChanges && (
                    <DropdownMenuItem onClick={onToggleFileChanges}>
                      <FileCode2 />
                      File changes
                      {showFileChanges && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                  {session && (
                    <DropdownMenuItem onClick={onToggleStats}>
                      {showStats ? <PanelRightClose /> : <PanelRightOpen />}
                      Session details
                      {showStats && <Check className="ml-auto" />}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {canViewUsage && (
                    <DropdownMenuItem onClick={() => setUsageOpen(true)}>
                      <ChartColumn />
                      Usage &amp; cost…
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setMonitorOpen(true)}>
                    <Activity />
                    Server monitor…
                  </DropdownMenuItem>
                  {networkUrl && (
                    <DropdownMenuItem onClick={handleCopyNetworkUrl}>
                      <Globe className="text-success" />
                      Copy network URL
                      <span className="ml-auto truncate pl-2 font-mono text-[11px] text-muted-foreground">
                        {networkUrl}
                      </span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={onOpenSettings}>
                    <Settings />
                    Settings
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {can("killAny") && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={onKillAll}
                        disabled={killing}
                      >
                        <Skull />
                        {killing ? "Stopping processes…" : "Stop all agent processes"}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {canViewUsage && <UsageCostDialog open={usageOpen} onOpenChange={setUsageOpen} />}
      <PowerMonitor open={monitorOpen} onOpenChange={setMonitorOpen} />
    </>
  )
})
```

**Insertion point for a Share item:** the second `DropdownMenuGroup` (lines 290-310), gated on `session &&` — e.g. right after the `Usage & cost…` item, following the `…` suffix + dialog-state pattern (`const [shareOpen, setShareOpen] = useState(false)` at :130, `<ShareDialog open={shareOpen} onOpenChange={setShareOpen} />` next to line 339-340). No new props are needed: `session` comes from `useSessionContext()`.

Icon imports live at `src/components/FloatingChrome.tsx:3-20` (lucide-react named imports, alphabetized).

`SessionContextValue` fields available (`/Users/gentritbiba/agent-window/.worktrees/session-sharing/src/contexts/SessionContext.tsx:42-80`): `session`, `sessionSource`, `isLive`, `sseState`, `isCompacting`, `turnError`, `undoRedo`, `pendingInteraction`, `permissionRequests`, `permissionResponding`, `respondPermission(requestId, behavior)`, `respondAllPermissions(behavior)`, `isSubAgentView`, `slashSuggestions`, `slashSuggestionsLoading`, `actions.{handleStopSession, handleEditConfig, handleEditCommand, handleExpandCommand, handleOpenBranches, handleBranchFromHere, handleToggleExpandAll, handleLoadSession}`.

---

## 16. `src/components/LoginScreen.tsx` — the ENTIRE file (184 lines)

`/Users/gentritbiba/agent-window/.worktrees/session-sharing/src/components/LoginScreen.tsx:1-184`:

```tsx
import { useCallback, useEffect, useState } from "react"
import { AlertCircle, Eye, EyeOff, Lock } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/Spinner"
import { clearToken, getServerEdition } from "@/lib/auth"
import type { CogpitEdition } from "../../shared/contracts/team"

interface LoginScreenProps {
  onAuthenticated: () => void
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [edition, setEdition] = useState<CogpitEdition | null>(null)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const isTeam = edition === "team"

  useEffect(() => {
    let cancelled = false
    void getServerEdition().then((resolved) => {
      if (!cancelled) setEdition(resolved)
    })
    return () => { cancelled = true }
  }, [])

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password.trim() || (isTeam && !username.trim())) return

    setLoading(true)
    setError(null)

    try {
      const response = await fetch("/api/auth/verify", isTeam
        ? {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json",
              "X-Cogpit-Client": "1",
            },
            body: JSON.stringify({ username: username.trim(), password }),
          }
        : {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: {
              "Authorization": `Bearer ${password}`,
              "Content-Type": "application/json",
              "X-Cogpit-Client": "1",
            },
          })

      const data = await response.json() as { valid?: boolean; error?: string }
      if (response.ok && data.valid) {
        clearToken()
        setPassword("")
        setUsername("")
        onAuthenticated()
      } else {
        setError(data.error || (isTeam ? "Invalid credentials" : "Invalid password"))
      }
    } catch {
      setError("Failed to connect to server")
    } finally {
      setLoading(false)
    }
  }, [isTeam, onAuthenticated, password, username])

  const submitDisabled = loading || !password.trim() || (isTeam && !username.trim())

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8">
      <form onSubmit={handleSubmit} className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <div className="mb-2 flex size-9 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
              <Lock className="size-4" />
            </div>
            <CardTitle>Sign in to Cogpit</CardTitle>
            <CardDescription>
              {isTeam ? "Use your team account to continue." : "Enter the server password to continue."}
            </CardDescription>
          </CardHeader>

          {edition === null ? (
            <CardContent>
              <div
                className="flex min-h-24 items-center justify-center"
                role="status"
                aria-label="Checking server"
              >
                <Spinner className="size-5 text-muted-foreground" />
              </div>
            </CardContent>
          ) : (
            <>
              <CardContent className="flex flex-col gap-4">
                <FieldGroup>
                  {isTeam && (
                    <Field>
                      <FieldLabel htmlFor="login-username">Username</FieldLabel>
                      <Input
                        id="login-username"
                        type="text"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        placeholder="Username"
                        autoComplete="username"
                        autoFocus
                      />
                    </Field>
                  )}

                  <Field>
                    <FieldLabel htmlFor="login-password">Password</FieldLabel>
                    <InputGroup>
                      <InputGroupInput
                        id="login-password"
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        placeholder="Password"
                        autoComplete="current-password"
                        autoFocus={!isTeam}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupButton
                          size="icon-xs"
                          onClick={() => setShowPassword((visible) => !visible)}
                          aria-label={showPassword ? "Hide password" : "Show password"}
                        >
                          {showPassword ? <EyeOff /> : <Eye />}
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </Field>
                </FieldGroup>

                {error && (
                  <Alert variant="destructive">
                    <AlertCircle aria-hidden="true" />
                    <AlertTitle>Sign in failed</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
              </CardContent>

              <CardFooter>
                <Button type="submit" className="w-full" disabled={submitDisabled}>
                  {loading && <Spinner data-icon="inline-start" />}
                  Connect
                </Button>
              </CardFooter>
            </>
          )}
        </Card>
      </form>
    </main>
  )
}
```

Rendered at `/Users/gentritbiba/agent-window/.worktrees/session-sharing/src/App.tsx:861`:

```tsx
    return <LoginScreen onAuthenticated={networkAuth.handleAuthenticated} />
```

(imported at `src/App.tsx:72`). Existing test: `src/components/__tests__/LoginScreen.test.tsx`.

Note it uses **raw `fetch`, not `authFetch`** — the login path must not be intercepted by the 401 handler.

---

## 17. Test idiom

### `server/__tests__/http-fixtures.ts` — the ENTIRE file (68 lines)

```ts
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Dirent } from "node:fs"
import type { Mock } from "vitest"

import type { Middleware } from "../helpers"
import type { SessionMeta } from "../lib/sessionMetaCache"

export type ReaddirTestEntry = string | Dirent<string>
export type ReaddirMock = Mock<(...args: unknown[]) => Promise<ReaddirTestEntry[]>>

/** Select the string/Dirent overload that route tests exercise. */
export function asReaddirMock(mock: object): ReaddirMock {
  return mock as ReaddirMock
}

/** Complete metadata fixture that stays aligned with the parser contract. */
export function makeSessionMeta(
  overrides: Partial<SessionMeta> & Record<string, unknown> = {},
): SessionMeta {
  return {
    sessionId: "session-1",
    version: "",
    gitBranch: "",
    model: "",
    slug: "",
    name: "",
    aiTitle: "",
    cwd: "",
    firstUserMessage: "",
    lastUserMessage: "",
    timestamp: "",
    lastTimestamp: "",
    turnCount: 0,
    lineCount: 0,
    branchedFrom: undefined,
    teamName: "",
    agentName: "",
    isSubagent: false,
    parentSessionId: null,
    ...overrides,
  } as SessionMeta
}

/**
 * Preserve the observable fields on a lightweight request double while
 * acknowledging the Node request contract at the test boundary.
 */
export function asIncomingMessage<T extends object>(request: T): T & IncomingMessage {
  return request as T & IncomingMessage
}

/**
 * Preserve test-only response inspection helpers while satisfying route
 * middleware's Node response contract.
 */
export function asServerResponse<T extends object>(response: T): T & ServerResponse {
  return response as T & ServerResponse
}

/** Fail clearly during test setup instead of invoking an optional handler. */
export function getRouteHandler(
  handlers: ReadonlyMap<string, Middleware>,
  path: string,
): Middleware {
  const handler = handlers.get(path)
  if (!handler) throw new Error(`Route was not registered: ${path}`)
  return handler
}
```

### `server/__tests__/routes/session-status.test.ts` — the ENTIRE file (150 lines)

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockFindJsonlPath = vi.hoisted(() => vi.fn())
const mockGetSessionStatus = vi.hoisted(() => vi.fn())
const mockPersistentSessions = vi.hoisted(() => new Map<string, { dead: boolean }>())
const mockActiveProcesses = vi.hoisted(() => new Map<string, unknown>())
const mockSdkSessions = vi.hoisted(() => new Map<string, { running: boolean }>())
const mockIsSDKQueryLive = vi.hoisted(() => vi.fn())
const mockGetActiveTurnId = vi.hoisted(() => vi.fn())

vi.mock("../../helpers", () => ({
  findJsonlPath: mockFindJsonlPath,
  getSessionStatus: mockGetSessionStatus,
  persistentSessions: mockPersistentSessions,
  activeProcesses: mockActiveProcesses,
}))

vi.mock("../../sdk-session", () => ({
  sdkSessions: mockSdkSessions,
  isSDKQueryLive: mockIsSDKQueryLive,
}))

vi.mock("../../codex-app-server", () => ({
  codexAppServer: { getActiveTurnId: mockGetActiveTurnId },
}))

import type { UseFn, Middleware } from "../../helpers"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"
import { registerSessionStatusRoutes } from "../../routes/session-status"

function buildHandler(): Middleware {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => {
    handlers.set(path, handler)
  }
  registerSessionStatusRoutes(use)
  return getRouteHandler(handlers, "/api/session-status/")
}

async function request(method: string, url: string) {
  let body = ""
  const res = asServerResponse({
    statusCode: 200,
    setHeader: vi.fn(),
    end: (data?: string) => { body = data ?? "" },
  })
  const next = vi.fn()
  await buildHandler()(asIncomingMessage({ method, url }), res, next)
  return { res, next, json: () => JSON.parse(body) }
}

describe("GET /api/session-status/:sessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPersistentSessions.clear()
    mockActiveProcesses.clear()
    mockSdkSessions.clear()
    mockFindJsonlPath.mockResolvedValue("/tmp/projects/-tmp-app/abc.jsonl")
    mockGetSessionStatus.mockResolvedValue({ status: "completed" })
    mockIsSDKQueryLive.mockReturnValue(false)
    mockGetActiveTurnId.mockReturnValue(undefined)
  })

  it("delegates non-GET requests and nested paths to next()", async () => {
    const post = await request("POST", "/abc")
    expect(post.next).toHaveBeenCalledOnce()

    const nested = await request("GET", "/abc/turn/2")
    expect(nested.next).toHaveBeenCalledOnce()
  })

  it("returns 404 when no JSONL exists for the session", async () => {
    mockFindJsonlPath.mockResolvedValue(null)
    const { res, json } = await request("GET", "/missing-session")
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: "Session not found" })
  })

  it("reports tail-derived status with live=false running=false when nothing is tracked", async () => {
    const { res, json } = await request("GET", "/abc")
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ sessionId: "abc", live: false, running: false, status: "completed" })
  })

  it("passes toolName and terminalReason through from the status scan", async () => {
    mockGetSessionStatus.mockResolvedValue({
      status: "completed",
      terminalReason: "max_turns",
    })
    const { json } = await request("GET", "/abc")
    expect(json()).toEqual({
      sessionId: "abc",
      live: false,
      running: false,
      status: "completed",
      terminalReason: "max_turns",
    })
  })

  it("reports live=true running=false between turns of an open SDK session", async () => {
    // The stale-tail race: the query is held open for follow-ups but no turn
    // is in flight. running must NOT be inferred from query liveness.
    mockSdkSessions.set("abc", { running: false })
    mockIsSDKQueryLive.mockReturnValue(true)

    const { json } = await request("GET", "/abc")
    expect(json()).toEqual({ sessionId: "abc", live: true, running: false, status: "completed" })
    expect(mockIsSDKQueryLive).toHaveBeenCalledWith(mockSdkSessions.get("abc"))
  })

  it("reports running=true while an SDK turn is in flight", async () => {
    mockSdkSessions.set("abc", { running: true })
    mockIsSDKQueryLive.mockReturnValue(true)
    mockGetSessionStatus.mockResolvedValue({ status: "tool_use", toolName: "Bash" })

    const { json } = await request("GET", "/abc")
    expect(json()).toEqual({
      sessionId: "abc",
      live: true,
      running: true,
      status: "tool_use",
      toolName: "Bash",
    })
  })

  it("reports live=true for a tracked legacy process, but not a dead one", async () => {
    mockPersistentSessions.set("abc", { dead: true })
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: false, running: false })

    mockPersistentSessions.set("abc", { dead: false })
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: true, running: false })
  })

  it("reports running=true for a tracked one-shot process", async () => {
    mockActiveProcesses.set("abc", { pid: 123 })
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: false, running: true })
  })

  it("reports live=true running=true for an active native Codex turn", async () => {
    mockGetActiveTurnId.mockReturnValue("turn-1")
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: true, running: true })
  })

  it("returns 500 when the status scan fails", async () => {
    mockGetSessionStatus.mockRejectedValue(new Error("boom"))
    const { res } = await request("GET", "/abc")
    expect(res.statusCode).toBe(500)
  })
})
```

**Idiom checklist:** `// @vitest-environment node` first line → `vi.hoisted()` mocks → `vi.mock("../../<module>")` → imports **after** mocks → `buildHandler()` capturing `use` into a `Map` → `getRouteHandler(handlers, "<mount path>")` → `request()` helper building `asServerResponse({statusCode, setHeader: vi.fn(), end})` and `asIncomingMessage({method, url})` → `await handler(req, res, next)`.

Note: `UseFn` and `Middleware` are imported from `"../../helpers"` in tests (re-exported there), not from `"../../http"`.

A route with an on-disk store (like a share registry) should follow `server/__tests__/routes/session-config.test.ts` instead, which uses a real temp dir and `mockDirs` (`server/__tests__/routes/session-config.test.ts:10, 102, 161`). Registry-level tests: `server/__tests__/hub/registry.test.ts` (`initDeviceRegistry(dir)` against a real temp dir).

---

## 18. `server/__tests__/api-routes.test.ts` — the `CANONICAL_ROUTE_IDS` pattern

`/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/__tests__/api-routes.test.ts:1-61`:

```ts
// @vitest-environment node

import { describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../helpers"

vi.mock("../lib/leakReaper", () => ({
  getRecentlyReaped: vi.fn(() => []),
  killPids: vi.fn(() => []),
  startLeakReaper: vi.fn(),
}))

import { API_ROUTE_REGISTRY, registerApiRoutes } from "../api-routes"
import { ROUTE_POLICIES } from "../team/policy"
import type { HubMode } from "../routes/hello"

const CANONICAL_ROUTE_IDS = [
  "hello",
  "devices",
  "hub",
  "performance",
  "config",
  "team-admin",
  "projects",
  "claude",
  "claude-new",
  "claude-manage",
  "ports",
  "teams",
  "team-session",
  "workflows",
  "undo",
  "files",
  "files-watch",
  "session-file-changes",
  "session-config",
  "session-context",
  "session-status",
  "editor",
  "worktrees",
  "usage",
  "usage-cost",
  "slash-suggestions",
  "config-browser",
  "local-file",
  "file-content",
  "project-files",
  "project-file",
  "git-status",
  "project-icon",
  "git-diff",
  "mcp",
  "notifications",
  "scripts",
  "permissions",
  "mission-control",
  "ask-user",
  "models",
  "codex-runtime",
  "claude-runtime",
  "provider-updates",
] as const
```

The three assertions that will fail without a matching update (`server/__tests__/api-routes.test.ts:73-79, 133-150`):

```ts
describe("API route registry", () => {
  it("has unique IDs in the documented canonical order", () => {
    const ids = API_ROUTE_REGISTRY.map(({ id }) => id)

    expect(ids).toEqual(CANONICAL_ROUTE_IDS)
    expect(new Set(ids).size).toBe(ids.length)
  })
```

```ts
describe("team route policies", () => {
  const registryIds = API_ROUTE_REGISTRY.map(({ id }) => id)

  it("covers every registry id with at least one policy rule", () => {
    for (const id of registryIds) {
      const rules = ROUTE_POLICIES[id]
      expect(rules, `route id "${id}" has no policy entry`).toBeDefined()
      expect(rules?.length, `route id "${id}" has an empty policy entry`).toBeGreaterThan(0)
    }
  })

  it("has no policy entries for ids missing from the registry", () => {
    const known = new Set<string>(registryIds)
    for (const id of Object.keys(ROUTE_POLICIES)) {
      expect(known.has(id), `policy entry "${id}" is not a registry id`).toBe(true)
    }
  })
})
```

---

## 19. Adding a route module — confirmed answer

**There is NO `server/routes/index.ts` barrel.** `ls server/routes/` has no index/barrel file; the only aggregation point is `server/api-routes.ts`. Some routes have a sibling directory of helpers (`server/routes/claude-manage/`, `server/routes/projects/`, `server/routes/ports/`, `server/routes/scripts/`, `server/routes/undo/`, `server/routes/worktrees/`, `server/routes/config-browser/`, `server/routes/claude-new/`) — these are internal, not barrels.

`registerApiRoutes` is called from exactly two production sites plus the test:
- `/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/app-server.ts:103` — `registerApiRoutes(use, { mode: environment.mode })` (Electron + standalone)
- `/Users/gentritbiba/agent-window/.worktrees/session-sharing/server/api-plugin.ts:75` — `registerApiRoutes(use, { mode: "dev" })` (Vite)

Neither needs editing.

### Exact 4-file diff shape to add a `shares` route

**1. `server/routes/shares.ts` (new file)** — export must be `export function registerShareRoutes(use: UseFn) { use("/api/shares", handler) }`.

**2. `server/api-routes.ts`** — two lines, alphabetical in the import block, canonical-order position in the registry:

```diff
 import { registerSessionStatusRoutes } from "./routes/session-status"
+import { registerShareRoutes } from "./routes/shares"
 import { registerSlashSuggestionRoutes } from "./routes/slash-suggestions"
```
```diff
   apiRoute("session-status", registerSessionStatusRoutes),
+  apiRoute("shares", registerShareRoutes),
   apiRoute("editor", registerEditorRoutes),
```

**3. `server/team/policy.ts`** — one entry in `ROUTE_POLICIES` (required; missing entry fails `api-routes.test.ts` and `requirementFor` defaults to `"admin"`):

```diff
   "session-status": authed("/api/session-status/"),
+  shares: [
+    { prefix: "/api/shares/join", requires: "public" },
+    { prefix: "/api/shares", requires: "authed" },
+  ],
```

**4. `server/__tests__/api-routes.test.ts`** — one line in `CANONICAL_ROUTE_IDS`, at the same index:

```diff
   "session-status",
+  "shares",
   "editor",
```

**Plus, if the share route serves SSE:** add its path to `isAuthenticatedHttpStreamRequest` in `server/security.ts:306-316`. **If it needs a pre-auth login endpoint:** add it to `PUBLIC_PATHS` in `server/security.ts:626`.