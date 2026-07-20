import { readFile, writeFile, chmod } from "node:fs/promises"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

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
  addedAt: number
}

export interface DeviceRuntime {
  authState: "ok" | "bad-password" | "unknown"
  lastProbe?: number
  lastHello?: unknown
}

/** Device shape safe to serialize to API clients: no password, includes runtime. */
export type PublicDevice = Omit<HubDevice, "password"> & { runtime: DeviceRuntime }

export interface AddDeviceInput {
  name: string
  host: string
  port?: number
  tls?: boolean
  auth: "password" | "none"
  password?: string
}

export type UpdateDeviceInput = Partial<Pick<HubDevice, "name" | "host" | "port" | "tls" | "auth" | "password">>

const DEFAULT_PORT = 19384
const DEFAULT_TLS_PORT = 443

// ── Module state ─────────────────────────────────────────────────────

let registryPath: string | null = null
const devices = new Map<string, HubDevice>()
const runtimes = new Map<string, DeviceRuntime>()

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
    addedAt: typeof e.addedAt === "number" ? e.addedAt : 0,
  }
}

async function persist(): Promise<void> {
  if (!registryPath) return
  const payload = JSON.stringify([...devices.values()], null, 2)
  // mode on writeFile only applies when the file is created; chmod after
  // every write guarantees an already-existing file stays locked to 0600.
  await writeFile(registryPath, payload, { mode: 0o600 })
  await chmod(registryPath, 0o600)
}

/**
 * Point the registry at `<dir>/devices.local.json` and load it. A missing or
 * corrupt file yields an empty registry rather than throwing.
 */
export async function initDeviceRegistry(dir: string): Promise<void> {
  registryPath = join(dir, "devices.local.json")
  devices.clear()
  runtimes.clear()

  let raw: string
  try {
    raw = await readFile(registryPath, "utf-8")
  } catch {
    // Missing file (first run) or unreadable → start empty.
    return
  }

  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const device = normalizeDevice(entry)
        if (device) devices.set(device.id, device)
      }
    }
  } catch {
    // Corrupt JSON → start empty rather than crashing the shell.
  }
}

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

// ── Mutations ────────────────────────────────────────────────────────

export async function addDevice(input: AddDeviceInput): Promise<HubDevice> {
  const device: HubDevice = {
    id: `dev_${randomBytes(8).toString("hex")}`,
    name: input.name,
    host: input.host,
    port: input.port ?? (input.tls ? DEFAULT_TLS_PORT : DEFAULT_PORT),
    tls: input.tls ? true : undefined,
    auth: input.auth,
    password: input.auth === "password" ? input.password : undefined,
    addedAt: Date.now(),
  }
  devices.set(device.id, device)
  runtimes.set(device.id, { authState: "unknown" })
  await persist()
  return device
}

export async function updateDevice(id: string, patch: UpdateDeviceInput): Promise<HubDevice | undefined> {
  const existing = devices.get(id)
  if (!existing) return undefined

  const next: HubDevice = { ...existing }
  if (patch.name !== undefined) next.name = patch.name
  if (patch.host !== undefined) next.host = patch.host
  if (patch.port !== undefined) next.port = patch.port
  if (patch.tls !== undefined) next.tls = patch.tls ? true : undefined
  if (patch.auth !== undefined) next.auth = patch.auth
  if (patch.password !== undefined) next.password = patch.password
  // A device switched to token-less auth must not keep a stale password.
  if (next.auth === "none") next.password = undefined

  devices.set(id, next)
  await persist()
  return next
}

export async function removeDevice(id: string): Promise<boolean> {
  const existed = devices.delete(id)
  runtimes.delete(id)
  if (existed) await persist()
  return existed
}

// ── Host validation ──────────────────────────────────────────────────

const LOOPBACK_MSG = "Loopback hosts are not allowed (use the local-tunnel option for ssh tunnels)"
const LINK_LOCAL_MSG = "Link-local hosts are not allowed"

/**
 * Fold an IPv4-mapped IPv6 hostname (`::ffff:127.0.0.1`) to its dotted IPv4.
 * The URL parser normalizes the mapped tail to hex words (`::ffff:7f00:1`), so
 * accept both the dotted and hex-word forms. Returns null when not IPv4-mapped.
 */
function mappedIpv4(hostname: string): string | null {
  const match = /^::ffff:(.+)$/.exec(hostname)
  if (!match) return null
  if (match[1].includes(".")) return match[1]
  const words = match[1].split(":")
  if (words.length !== 2) return null
  const hi = parseInt(words[0], 16)
  const lo = parseInt(words[1], 16)
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
}

/** Reject loopback / link-local / wildcard hostnames; null when acceptable. */
function blockedAddressReason(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h.endsWith(".localhost")) return LOOPBACK_MSG
  if (h === "::1" || h === "::ffff:127.0.0.1") return LOOPBACK_MSG
  if (/^127\./.test(h) || h === "0.0.0.0") return LOOPBACK_MSG
  if (/^169\.254\./.test(h)) return LINK_LOCAL_MSG
  const mapped = mappedIpv4(h)
  if (mapped) {
    if (/^127\./.test(mapped) || mapped === "0.0.0.0") return LOOPBACK_MSG
    if (/^169\.254\./.test(mapped)) return LINK_LOCAL_MSG
  }
  return null
}

/**
 * Guard against registering hosts that would let the proxy reach the hub
 * machine itself (SSRF / loopback). Returns an error message string when the
 * host is rejected, or `null` when it is acceptable.
 *
 * The host is parsed the way `fetch()` will interpret it, which closes the
 * bypasses that fool a raw string check but still resolve to loopback:
 *  - URL userinfo (`foo@127.0.0.1`) hides the real host behind credentials.
 *  - Non-dotted IPv4 forms — decimal `2130706433`, hex `0x7f000001`, octal
 *    `0177.0.0.1` — are normalized to their dotted quad before the checks run.
 *
 * `allowLocalTunnel` opts into the ssh-tunnel pattern where the device is
 * reached over localhost; such devices register `auth: "none"`. It relaxes the
 * loopback/link-local checks, but userinfo is always rejected.
 */
export function validateDeviceHost(host: string, allowLocalTunnel: boolean): string | null {
  const trimmed = host.trim()
  if (!trimmed) return "Host is required"

  // Bare IPv6 ("::1", "::ffff:127.0.0.1") is not a valid URL host without
  // brackets; wrap it so the parser accepts it. A host:port keeps its single
  // colon and is left untouched.
  const forUrl =
    (trimmed.match(/:/g)?.length ?? 0) >= 2 && !trimmed.includes("[")
      ? `[${trimmed}]`
      : trimmed

  let parsed: URL
  try {
    parsed = new URL(`http://${forUrl}`)
  } catch {
    return "Invalid host"
  }

  if (parsed.username || parsed.password) {
    return "Host must not include user credentials"
  }

  if (allowLocalTunnel) return null

  return blockedAddressReason(parsed.hostname)
}
