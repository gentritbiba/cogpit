import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { readOwnerOnlyJsonArray, writeOwnerOnlyJson } from "../atomicJsonFile"
import { replaceAll, serialQueue } from "../lib/serialQueue"

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

/**
 * Whether two registry records target the same endpoint with the same
 * credentials. Long-running proxy and probe operations use this to reject a
 * stale snapshot before connecting or publishing runtime state.
 */
export function sameDeviceConnection(a: HubDevice, b: HubDevice): boolean {
  return a.id === b.id
    && a.host === b.host
    && a.port === b.port
    && a.tls === b.tls
    && a.auth === b.auth
    && a.username === b.username
    && a.password === b.password
    && (a.connectionRevision ?? 0) === (b.connectionRevision ?? 0)
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
  username?: string
}

export type UpdateDeviceInput =
  Partial<Pick<HubDevice, "name" | "host" | "port" | "tls" | "auth" | "password">>
  & {
    /** `null` detaches the stored username; absent leaves it unchanged. */
    username?: string | null
  }

export type ConditionalDeviceUpdateResult =
  | { status: "updated"; device: HubDevice }
  | { status: "missing" }
  | { status: "conflict" }

const DEFAULT_PORT = 19384
const DEFAULT_TLS_PORT = 443

// ── Module state ─────────────────────────────────────────────────────

let registryPath: string | null = null
const devices = new Map<string, HubDevice>()
const runtimes = new Map<string, DeviceRuntime>()
const queue = serialQueue()

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

async function persist(
  filePath: string | null,
  snapshot: readonly HubDevice[],
): Promise<void> {
  if (!filePath) return
  await writeOwnerOnlyJson(filePath, snapshot)
}

interface DeviceMutation<T> {
  changed: boolean
  value: T
  commitRuntime?: () => void
}

function commitDeviceMutation<T>(
  mutate: (draft: Map<string, HubDevice>) => DeviceMutation<T>,
): Promise<T> {
  return queue.run(async () => {
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
    replaceAll(devices, draft)
    mutation.commitRuntime?.()
    return mutation.value
  })
}

/**
 * Point the registry at `<dir>/devices.local.json` and load it. A missing or
 * corrupt file yields an empty registry rather than throwing.
 */
export async function initDeviceRegistry(dir: string): Promise<void> {
  await queue.run(async () => {
    const nextRegistryPath = join(dir, "devices.local.json")
    const loadedDevices = await readOwnerOnlyJsonArray(
      nextRegistryPath,
      normalizeDevice,
      (device) => device.id,
    )

    registryPath = nextRegistryPath
    replaceAll(devices, loadedDevices)
    runtimes.clear()
  })
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

function applyDevicePatch(existing: HubDevice, patch: UpdateDeviceInput): HubDevice {
  const next: HubDevice = { ...existing }
  if (patch.name !== undefined) next.name = patch.name
  if (patch.host !== undefined) next.host = patch.host
  if (patch.port !== undefined) next.port = patch.port
  if (patch.tls !== undefined) next.tls = patch.tls ? true : undefined
  if (patch.auth !== undefined) next.auth = patch.auth
  if (patch.password !== undefined) next.password = patch.password
  if (patch.username !== undefined) next.username = patch.username ?? undefined
  // A device switched to token-less auth must not keep stale credentials.
  if (next.auth === "none") {
    next.password = undefined
    next.username = undefined
  }
  return next
}

export async function updateDevice(id: string, patch: UpdateDeviceInput): Promise<HubDevice | undefined> {
  const touchesConnection = patch.host !== undefined
    || patch.port !== undefined
    || patch.tls !== undefined
    || patch.auth !== undefined
    || patch.password !== undefined
    || patch.username !== undefined
  if (touchesConnection) {
    const expected = getDevice(id)
    if (!expected) return undefined
    const result = await updateDeviceIfConnectionMatches(id, expected, patch)
    return result.status === "updated" ? result.device : undefined
  }
  return commitDeviceMutation((draft) => {
    const existing = draft.get(id)
    if (!existing) return { changed: false, value: undefined }

    const next = applyDevicePatch(existing, patch)
    draft.set(id, next)
    return { changed: true, value: next }
  })
}

/** Commit only if the connection tuple verified by the caller is still current. */
export async function updateDeviceIfConnectionMatches(
  id: string,
  expected: HubDevice,
  patch: UpdateDeviceInput,
): Promise<ConditionalDeviceUpdateResult> {
  return commitDeviceMutation<ConditionalDeviceUpdateResult>((draft) => {
    const existing = draft.get(id)
    if (!existing) return { changed: false, value: { status: "missing" } }
    if (!sameDeviceConnection(existing, expected)) {
      return { changed: false, value: { status: "conflict" } }
    }

    const next = applyDevicePatch(existing, patch)
    next.connectionRevision = (existing.connectionRevision ?? 0) + 1
    draft.set(id, next)
    return { changed: true, value: { status: "updated", device: next } }
  })
}

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
