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
}

interface AttemptRecord {
  at: number
  error?: Error
}

const tokenCache = new Map<string, CachedToken>()
const inflight = new Map<string, Promise<string | null>>()
const lastAttempt = new Map<string, AttemptRecord>()

// ── Public API ───────────────────────────────────────────────────────

/**
 * Resolve a device auth token, minting one if needed.
 * - `auth: "none"` devices resolve to `null` (no Authorization header).
 * - A cached token younger than {@link TOKEN_TTL_MS} is reused.
 * - Otherwise a mint is performed, single-flighted per device.
 */
export function getDeviceToken(device: HubDevice): Promise<string | null> {
  if (device.auth === "none") return Promise.resolve(null)

  const id = device.id

  const cached = tokenCache.get(id)
  if (cached && Date.now() - cached.mintedAt < TOKEN_TTL_MS) {
    return Promise.resolve(cached.token)
  }

  const existing = inflight.get(id)
  if (existing) return existing

  const promise = mint(device).finally(() => {
    inflight.delete(id)
  })
  inflight.set(id, promise)
  return promise
}

/** Drop any cached token for a device, forcing the next call to re-mint. */
export function invalidateDeviceToken(id: string): void {
  tokenCache.delete(id)
}

// ── Minting ──────────────────────────────────────────────────────────

async function mint(device: HubDevice): Promise<string> {
  const id = device.id

  // Cooldown: if the previous attempt failed recently, rethrow without hitting
  // the network so we never trip the device's auth rate limit.
  const prev = lastAttempt.get(id)
  if (prev?.error && Date.now() - prev.at < MINT_COOLDOWN_MS) {
    throw prev.error
  }

  const record: AttemptRecord = { at: Date.now() }
  lastAttempt.set(id, record)

  const url = `http://${device.host}:${device.port}/api/auth/verify`

  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${device.password ?? ""}` },
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    })
  } catch (err) {
    const error = new DeviceUnreachableError(
      id,
      `Could not reach device "${device.name}" at ${device.host}:${device.port}`,
      { cause: err },
    )
    record.error = error
    setDeviceRuntime(id, { lastProbe: Date.now() })
    throw error
  }

  // Invalid password: the device says no. Mark the registry and stop trying.
  if (res.status === 401 || res.status === 403) {
    const error = new DeviceAuthError(id, `Device "${device.name}" rejected the password`, res.status)
    record.error = error
    setDeviceRuntime(id, { authState: "bad-password", lastProbe: Date.now() })
    throw error
  }

  if (!res.ok) {
    const error = new DeviceUnreachableError(
      id,
      `Device "${device.name}" returned HTTP ${res.status} while minting a token`,
    )
    record.error = error
    setDeviceRuntime(id, { lastProbe: Date.now() })
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
    setDeviceRuntime(id, { authState: "bad-password", lastProbe: Date.now() })
    throw error
  }

  tokenCache.set(id, { token: body.token, mintedAt: Date.now() })
  setDeviceRuntime(id, { authState: "ok", lastProbe: Date.now() })
  return body.token
}
