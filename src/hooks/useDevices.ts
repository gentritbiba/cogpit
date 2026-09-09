import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { hubFetch } from "@/lib/auth"
import {
  getActiveDeviceId,
  LOCAL_DEVICE_ID,
  recordDeviceConnectionRevision,
  switchDevice,
} from "@/lib/device"
import { readJson } from "@/lib/httpJson"
import type { CogpitEdition } from "../../shared/contracts/team"

// ── Types (mirror server/hub/registry.ts + server/routes/devices.ts) ─────────

/** The `/api/hello` handshake payload a device reports back through the hub. */
export interface DeviceHello {
  app?: string
  version?: string
  hubApi?: number
  mode?: string
  edition?: CogpitEdition
  /** Team device with no accounts yet — nothing can authenticate to it. */
  needsBootstrap?: boolean
  name?: string
  instanceId?: string
  networkAccess?: boolean
  configured?: boolean
}

export interface DeviceRuntime {
  authState: "ok" | "bad-password" | "unknown"
  lastProbe?: number
  /** Last successful hello; typed `unknown` on the wire — read defensively. */
  lastHello?: unknown
}

/** Device shape as served by GET /api/hub/devices (never carries a password). */
export interface PublicDevice {
  id: string
  name: string
  host: string
  port: number
  /** device is reached over https; absent for plain-http devices */
  tls?: boolean
  auth: "password" | "none"
  /** Non-secret account name used when the remote device is team edition. */
  username?: string
  /** Server-backed scope revision; changes only with host/account credentials. */
  connectionRevision?: number
  addedAt: number
  runtime: DeviceRuntime
}

/** The device object echoed by POST/PATCH (no runtime block). */
export interface DeviceSummary {
  id: string
  name: string
  host: string
  port: number
  tls?: boolean
  auth: "password" | "none"
  username?: string
  connectionRevision?: number
  addedAt: number
}

export type ProbeCode = "UNREACHABLE" | "NOT_COGPIT" | "LEGACY_NO_HELLO" | "SELF_ADD"

export type ProbeResult =
  | { ok: true; hello: DeviceHello }
  | { ok: false; code: ProbeCode; error?: string }

export interface AddDeviceInput {
  name?: string
  host: string
  port?: number
  tls?: boolean
  password?: string
  username?: string
  allowLocalTunnel?: boolean
}

export interface UpdateDeviceInput {
  name?: string
  host?: string
  port?: number
  tls?: boolean
  password?: string
  /** Empty/null detaches a team account and returns to password-only auth. */
  username?: string | null
}

export type MutationResult =
  | { ok: true; device: DeviceSummary }
  | { ok: false; code: string; error: string }

export type RemoveResult = { ok: true } | { ok: false; error: string }

export interface TestResult {
  ok: boolean
  reachable?: boolean
  authState?: DeviceRuntime["authState"]
  hello?: DeviceHello
  code?: string
  error?: string
}

export interface UseDevices {
  devices: PublicDevice[]
  activeDeviceId: string
  /** The active remote device, or `undefined` when the local device is active. */
  activeDevice: PublicDevice | undefined
  loading: boolean
  refresh: () => Promise<void>
  probe: (host: string, port?: number, allowLocalTunnel?: boolean, tls?: boolean) => Promise<ProbeResult>
  addDevice: (input: AddDeviceInput) => Promise<MutationResult>
  updateDevice: (id: string, patch: UpdateDeviceInput) => Promise<MutationResult>
  removeDevice: (id: string) => Promise<RemoveResult>
  testDevice: (id: string) => Promise<TestResult>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fired after any registry mutation so every `useDevices` consumer re-syncs. */
const DEVICES_CHANGED_EVENT = "cogpit-devices-changed"
const DEVICES_CHANGED_STORAGE_KEY = "cogpit:devices-changed"

function rememberDeviceRevision(device: Pick<DeviceSummary, "id" | "connectionRevision">): void {
  if (typeof device.connectionRevision === "number") {
    recordDeviceConnectionRevision(device.id, device.connectionRevision)
  }
}

function emitDevicesChanged(deviceId: string, connectionRevision?: number, removed = false): void {
  window.dispatchEvent(new CustomEvent(DEVICES_CHANGED_EVENT, {
    detail: { deviceId, connectionRevision, removed },
  }))
  try {
    localStorage.setItem(DEVICES_CHANGED_STORAGE_KEY, JSON.stringify({
      deviceId,
      connectionRevision,
      removed,
      nonce: `${Date.now()}:${Math.random()}`,
    }))
  } catch {
    // Cross-tab propagation is best-effort; this tab already updated itself.
  }
}

function announceDevicesChanged(device: DeviceSummary): void {
  rememberDeviceRevision(device)
  emitDevicesChanged(device.id, device.connectionRevision)
}

function devicePath(id: string, suffix = ""): string {
  return `/api/hub/devices/${encodeURIComponent(id)}${suffix}`
}

/** Read the reported app version from a device's last hello, if any. */
export function deviceVersion(device: PublicDevice): string | undefined {
  const hello = device.runtime.lastHello
  if (hello && typeof hello === "object") {
    const version = (hello as { version?: unknown }).version
    if (typeof version === "string") return version
  }
  return undefined
}

/** Read a device edition only from a validated hello payload. */
export function deviceEdition(device: PublicDevice): CogpitEdition | undefined {
  const hello = device.runtime.lastHello
  if (hello && typeof hello === "object") {
    const edition = (hello as { edition?: unknown }).edition
    if (edition === "team" || edition === "personal") return edition
  }
  return undefined
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Fetches and mutates the hub device registry. Fetches once on mount and
 * re-fetches on demand via {@link UseDevices.refresh} or after any mutation —
 * there is no background polling. All requests use {@link hubFetch} so they
 * always target the hub itself, never the active remote device.
 */
export function useDevices(): UseDevices {
  const [devices, setDevices] = useState<PublicDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [activeDeviceId, setActiveDeviceId] = useState<string>(() => getActiveDeviceId())
  const refreshSequence = useRef(0)

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    try {
      const res = await hubFetch("/api/hub/devices")
      if (!res.ok) return
      const data = await readJson(res)
      if (sequence !== refreshSequence.current) return
      const list = Array.isArray(data?.devices) ? (data.devices as PublicDevice[]) : []
      for (const device of list) rememberDeviceRevision(device)
      setDevices(list)
    } catch {
      // Best-effort: keep the previously loaded list on transient failures.
    } finally {
      if (sequence === refreshSequence.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Re-read the active device id on switch / browser navigation, and re-sync the
  // list whenever any consumer mutates the registry or the hub identity changes.
  // DeviceRoot survives App's auth-keyed remount, so without these auth events
  // its shortcut inventory would stay at the unauthenticated boot result.
  useEffect(() => {
    const updateActive = () => setActiveDeviceId(getActiveDeviceId())
    const resync = () => void refresh()
    const resyncFromStorage = (event: StorageEvent) => {
      if (event.key !== DEVICES_CHANGED_STORAGE_KEY) return
      try {
        const detail = JSON.parse(event.newValue ?? "null") as { deviceId?: unknown; removed?: unknown } | null
        if (detail?.removed === true
          && typeof detail.deviceId === "string"
          && getActiveDeviceId() === detail.deviceId) {
          switchDevice(LOCAL_DEVICE_ID)
        }
      } catch {
        // A malformed best-effort signal still means the registry may differ.
      }
      void refresh()
    }
    const resetAndResync = () => {
      refreshSequence.current += 1
      setDevices([])
      setLoading(true)
      void refresh()
    }
    const clearForAuthentication = () => {
      // Do not re-fetch here: hubFetch itself emits this event for a 401, so a
      // retry would recurse until login. Also invalidate an older in-flight list.
      refreshSequence.current += 1
      setDevices([])
      setLoading(false)
    }
    window.addEventListener("cogpit-device-changed", updateActive)
    window.addEventListener("popstate", updateActive)
    window.addEventListener(DEVICES_CHANGED_EVENT, resync)
    window.addEventListener("storage", resyncFromStorage)
    window.addEventListener("cogpit-auth-changed", resetAndResync)
    window.addEventListener("cogpit-identity-changed", resetAndResync)
    window.addEventListener("cogpit-auth-required", clearForAuthentication)
    return () => {
      window.removeEventListener("cogpit-device-changed", updateActive)
      window.removeEventListener("popstate", updateActive)
      window.removeEventListener(DEVICES_CHANGED_EVENT, resync)
      window.removeEventListener("storage", resyncFromStorage)
      window.removeEventListener("cogpit-auth-changed", resetAndResync)
      window.removeEventListener("cogpit-identity-changed", resetAndResync)
      window.removeEventListener("cogpit-auth-required", clearForAuthentication)
    }
  }, [refresh])

  const activeDevice = useMemo(
    () =>
      activeDeviceId === LOCAL_DEVICE_ID
        ? undefined
        : devices.find((device) => device.id === activeDeviceId),
    [devices, activeDeviceId],
  )

  const probe = useCallback(async (host: string, port?: number, allowLocalTunnel?: boolean, tls?: boolean): Promise<ProbeResult> => {
    try {
      const res = await hubFetch("/api/hub/devices/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The server validates the probe host too; forward the tunnel opt-in so
        // a legitimate loopback tunnel isn't rejected as SSRF. Undefined is
        // dropped by JSON.stringify and the server defaults it to false.
        body: JSON.stringify({ host, port, allowLocalTunnel, tls }),
      })
      const data = await readJson(res)
      if (data?.ok === true && data.hello) {
        return { ok: true, hello: data.hello as DeviceHello }
      }
      return {
        ok: false,
        code: (data?.code as ProbeCode) ?? "UNREACHABLE",
        error: typeof data?.error === "string" ? data.error : undefined,
      }
    } catch {
      return { ok: false, code: "UNREACHABLE", error: "Could not reach the device." }
    }
  }, [])

  const addDevice = useCallback(async (input: AddDeviceInput): Promise<MutationResult> => {
    try {
      const res = await hubFetch("/api/hub/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
      const data = await readJson(res)
      if (res.ok && data?.device) {
        const device = data.device as DeviceSummary
        announceDevicesChanged(device)
        return { ok: true, device }
      }
      return {
        ok: false,
        code: (data?.code as string) ?? "ERROR",
        error: typeof data?.error === "string" ? data.error : "Could not add the device.",
      }
    } catch {
      return { ok: false, code: "ERROR", error: "Could not add the device." }
    }
  }, [])

  const updateDevice = useCallback(
    async (id: string, patch: UpdateDeviceInput): Promise<MutationResult> => {
      try {
        const res = await hubFetch(devicePath(id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        })
        const data = await readJson(res)
        if (res.ok && data?.device) {
          const device = data.device as DeviceSummary
          announceDevicesChanged(device)
          return { ok: true, device }
        }
        return {
          ok: false,
          code: (data?.code as string) ?? "ERROR",
          error: typeof data?.error === "string" ? data.error : "Could not update the device.",
        }
      } catch {
        return { ok: false, code: "ERROR", error: "Could not update the device." }
      }
    },
    [],
  )

  const removeDevice = useCallback(async (id: string): Promise<RemoveResult> => {
    try {
      const res = await hubFetch(devicePath(id), { method: "DELETE" })
      if (res.ok) {
        // A deleted active target can no longer answer /api/hello or /api/me.
        // Leave it before broadcasting the registry change so identity
        // listeners observe local mode instead of revalidating against a 404.
        if (getActiveDeviceId() === id) switchDevice(LOCAL_DEVICE_ID)
        emitDevicesChanged(id, undefined, true)
        return { ok: true }
      }
      const data = await readJson(res)
      return { ok: false, error: typeof data?.error === "string" ? data.error : "Could not remove the device." }
    } catch {
      return { ok: false, error: "Could not remove the device." }
    }
  }, [])

  const testDevice = useCallback(async (id: string): Promise<TestResult> => {
    try {
      const res = await hubFetch(devicePath(id, "/test"), { method: "POST" })
      const data = await readJson(res)
      return (data as TestResult | null) ?? { ok: false, reachable: false, code: "UNREACHABLE" }
    } catch {
      return { ok: false, reachable: false, code: "UNREACHABLE" }
    }
  }, [])

  return {
    devices,
    activeDeviceId,
    activeDevice,
    loading,
    refresh,
    probe,
    addDevice,
    updateDevice,
    removeDevice,
    testDevice,
  }
}
