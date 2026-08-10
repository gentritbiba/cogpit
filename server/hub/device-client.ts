import { setDeviceRuntime, type HubDevice } from "./registry"

/**
 * Per-device token lifecycle for the hub proxy.
 *
 * A remote device issues short session tokens from `POST /api/auth/verify`
 * (Authorization: Bearer <password>). This module mints and caches one token
 * per device and enforces two protections against the device's own rate limit
 * (5 auth attempts / minute / IP):
 *
 *  1. Single-flight — concurrent callers for the same device share one inflight
 *     mint promise, so a device restart firing several SSE reconnects at once
 *     produces a single network request.
 *  2. Cooldown — after a failed mint, further attempts within
 *     `MINT_COOLDOWN_MS` rethrow the last error without touching the network.
 *
 * Errors are typed so the proxy can map them: `DeviceAuthError` (bad password →
 * registry authState "bad-password") and `DeviceUnreachableError` (network /
 * timeout).
 */

// ── Errors ───────────────────────────────────────────────────────────

export class DeviceAuthError extends Error {
  readonly deviceId: string
  readonly status?: number
  constructor(deviceId: string, message: string, status?: number) {
    super(message)
    this.name = "DeviceAuthError"
    this.deviceId = deviceId
    this.status = status
  }
}

export class DeviceUnreachableError extends Error {
  readonly deviceId: string
  constructor(deviceId: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "DeviceUnreachableError"
    this.deviceId = deviceId
  }
}

/** A credential update superseded this mint before its token could be used. */
export class DeviceCredentialsChangedError extends Error {
  readonly deviceId: string
  constructor(deviceId: string) {
    super(`Credentials changed while minting a token for device "${deviceId}"`)
    this.name = "DeviceCredentialsChangedError"
    this.deviceId = deviceId
  }
}

// ── Tuning ───────────────────────────────────────────────────────────

/** Reuse a minted token for this long before re-minting. */
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000 // 20 hours
/** Minimum spacing between mint attempts for a single device. */
const MINT_COOLDOWN_MS = 5000
/** Per-request timeout for the mint call. */
const MINT_TIMEOUT_MS = 5000

// ── State ────────────────────────────────────────────────────────────

interface CachedToken {
  token: string
  mintedAt: number
  generation: number
}

interface AttemptRecord {
  at: number
  generation: number
  error?: Error
}

interface InflightMint {
  generation: number
  promise: Promise<string | null>
}

export interface DeviceTokenLease {
  token: string | null
  generation: number
}

interface DeviceTokenAcquisition {
  generation: number
  promise: Promise<string | null>
}

const tokenCache = new Map<string, CachedToken>()
const inflight = new Map<string, InflightMint>()
const lastAttempt = new Map<string, AttemptRecord>()
const credentialGenerations = new Map<string, number>()

function currentGeneration(id: string): number {
  return credentialGenerations.get(id) ?? 0
}

function generationIsCurrent(id: string, generation: number): boolean {
  return currentGeneration(id) === generation
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Resolve a device auth token, minting one if needed.
 * - `auth: "none"` devices resolve to `null` (no Authorization header).
 * - A cached token younger than {@link TOKEN_TTL_MS} is reused.
 * - Otherwise a mint is performed, single-flighted per device.
 */
function acquireDeviceToken(device: HubDevice): DeviceTokenAcquisition {
  const id = device.id
  const generation = currentGeneration(id)
  if (device.auth === "none") return { generation, promise: Promise.resolve(null) }

  const cached = tokenCache.get(id)
  if (
    cached
    && cached.generation === generation
    && Date.now() - cached.mintedAt < TOKEN_TTL_MS
  ) {
    return { generation, promise: Promise.resolve(cached.token) }
  }

  const existing = inflight.get(id)
  if (existing?.generation === generation) return { generation, promise: existing.promise }

  const promise: Promise<string | null> = mint(device, generation).finally(() => {
    // An invalidation may have installed a newer generation's mint while this
    // one was still in flight. The stale completion must not delete it.
    if (inflight.get(id)?.promise === promise) inflight.delete(id)
  })
  inflight.set(id, { generation, promise })
  return { generation, promise }
}

export function getDeviceToken(device: HubDevice): Promise<string | null> {
  return acquireDeviceToken(device).promise
}

/** Resolve a token together with the exact generation it belongs to. */
export function getDeviceTokenLease(device: HubDevice): Promise<DeviceTokenLease> {
  const acquisition = acquireDeviceToken(device)
  return acquisition.promise.then((token) => ({ token, generation: acquisition.generation }))
}

/**
 * Advance the device's credential generation and drop generation-bound state.
 * Existing network requests cannot be cancelled reliably, but their eventual
 * completion can no longer overwrite the new generation's cache or runtime.
 */
export function invalidateDeviceToken(id: string): void {
  credentialGenerations.set(id, currentGeneration(id) + 1)
  tokenCache.delete(id)
  lastAttempt.delete(id)
}

/**
 * Invalidate a token generation only if it is still current. Concurrent 401s
 * from the same expired token therefore advance once and share the replacement
 * generation's single-flight mint.
 */
export function invalidateDeviceTokenGeneration(id: string, generation: number): boolean {
  if (!generationIsCurrent(id, generation)) return false
  invalidateDeviceToken(id)
  return true
}

// ── Minting ──────────────────────────────────────────────────────────

async function mint(device: HubDevice, generation: number): Promise<string> {
  const id = device.id

  // Cooldown: if the previous attempt failed recently, rethrow without hitting
  // the network so we never trip the device's auth rate limit.
  const prev = lastAttempt.get(id)
  if (
    prev?.generation === generation
    && prev.error
    && Date.now() - prev.at < MINT_COOLDOWN_MS
  ) {
    throw prev.error
  }

  const record: AttemptRecord = { at: Date.now(), generation }
  lastAttempt.set(id, record)

  const url = `${device.tls ? "https" : "http"}://${device.host}:${device.port}/api/auth/verify`

  // A team device authenticates as a named user (`user:pass` — usernames
  // reject ":", so the first colon always splits correctly); a personal
  // device takes the bare network password.
  const credential = device.username
    ? `${device.username}:${device.password ?? ""}`
    : device.password ?? ""

  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    })
  } catch (err) {
    const error = new DeviceUnreachableError(
      id,
      `Could not reach device "${device.name}" at ${device.host}:${device.port}`,
      { cause: err },
    )
    record.error = error
    if (generationIsCurrent(id, generation)) {
      setDeviceRuntime(id, { lastProbe: Date.now() })
    }
    throw error
  }

  // Invalid password: the device says no. Mark the registry and stop trying.
  if (res.status === 401 || res.status === 403) {
    const error = new DeviceAuthError(id, `Device "${device.name}" rejected the password`, res.status)
    record.error = error
    if (generationIsCurrent(id, generation)) {
      setDeviceRuntime(id, { authState: "bad-password", lastProbe: Date.now() })
    }
    throw error
  }

  if (!res.ok) {
    const error = new DeviceUnreachableError(
      id,
      `Device "${device.name}" returned HTTP ${res.status} while minting a token`,
    )
    record.error = error
    if (generationIsCurrent(id, generation)) {
      setDeviceRuntime(id, { lastProbe: Date.now() })
    }
    throw error
  }

  let body: { valid?: boolean; token?: unknown } | null = null
  try {
    body = (await res.json()) as { valid?: boolean; token?: unknown }
  } catch {
    body = null
  }

  if (!body || body.valid === false || typeof body.token !== "string" || !body.token) {
    const error = new DeviceAuthError(id, `Device "${device.name}" did not return a valid token`, res.status)
    record.error = error
    if (generationIsCurrent(id, generation)) {
      setDeviceRuntime(id, { authState: "bad-password", lastProbe: Date.now() })
    }
    throw error
  }

  if (!generationIsCurrent(id, generation)) {
    // Reject the caller as well as skipping the cache. Otherwise an HTTP/WS
    // proxy waiting on this promise could dispatch the old principal's token
    // after a credential PATCH has already committed.
    throw new DeviceCredentialsChangedError(id)
  }
  tokenCache.set(id, { token: body.token, mintedAt: Date.now(), generation })
  setDeviceRuntime(id, { authState: "ok", lastProbe: Date.now() })
  return body.token
}
