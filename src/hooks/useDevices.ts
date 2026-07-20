import { useCallback, useEffect, useMemo, useState } from "react"
import { hubFetch } from "@/lib/auth"
import { getActiveDeviceId, LOCAL_DEVICE_ID } from "@/lib/device"

// ── Types (mirror server/hub/registry.ts + server/routes/devices.ts) ─────────

/** The `/api/hello` handshake payload a device reports back through the hub. */
export interface DeviceHello {
  app?: string
  version?: string
  hubApi?: number
  mode?: string
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
  auth: "password" | "none"
  addedAt: number
  runtime: DeviceRuntime
}

/** The device object echoed by POST/PATCH (no runtime block). */
export interface DeviceSummary {
  id: string
  name: string
  host: string
  port: number
  auth: "password" | "none"
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
  password?: string
  allowLocalTunnel?: boolean
}

export interface UpdateDeviceInput {
  name?: string
  host?: string
  port?: number
  password?: string
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
  probe: (host: string, port?: number, allowLocalTunnel?: boolean) => Promise<ProbeResult>
  addDevice: (input: AddDeviceInput) => Promise<MutationResult>
  updateDevice: (id: string, patch: UpdateDeviceInput) => Promise<MutationResult>
  removeDevice: (id: string) => Promise<RemoveResult>
  testDevice: (id: string) => Promise<TestResult>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fired after any registry mutation so every `useDevices` consumer re-syncs. */
const DEVICES_CHANGED_EVENT = "cogpit-devices-changed"

function devicePath(id: string, suffix = ""): string {
  return `/api/hub/devices/${encodeURIComponent(id)}${suffix}`
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const data = (await res.json()) as unknown
    return data && typeof data === "object" ? (data as Record<string, unknown>) : null
  } catch {
    return null
  }
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

  const refresh = useCallback(async () => {
    try {
      const res = await hubFetch("/api/hub/devices")
      if (!res.ok) return
      const data = await readJson(res)
      const list = Array.isArray(data?.devices) ? (data.devices as PublicDevice[]) : []
      setDevices(list)
    } catch {
      // Best-effort: keep the previously loaded list on transient failures.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Re-read the active device id on switch / browser navigation, and re-sync the
  // list whenever any consumer mutates the registry.
  useEffect(() => {
    const updateActive = () => setActiveDeviceId(getActiveDeviceId())
    const resync = () => void refresh()
    window.addEventListener("cogpit-device-changed", updateActive)
    window.addEventListener("popstate", updateActive)
    window.addEventListener(DEVICES_CHANGED_EVENT, resync)
    return () => {
      window.removeEventListener("cogpit-device-changed", updateActive)
      window.removeEventListener("popstate", updateActive)
      window.removeEventListener(DEVICES_CHANGED_EVENT, resync)
    }
  }, [refresh])

  const activeDevice = useMemo(
    () =>
      activeDeviceId === LOCAL_DEVICE_ID
        ? undefined
        : devices.find((device) => device.id === activeDeviceId),
    [devices, activeDeviceId],
  )

  const probe = useCallback(async (host: string, port?: number, allowLocalTunnel?: boolean): Promise<ProbeResult> => {
    try {
      const res = await hubFetch("/api/hub/devices/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The server validates the probe host too; forward the tunnel opt-in so
        // a legitimate loopback tunnel isn't rejected as SSRF. Undefined is
        // dropped by JSON.stringify and the server defaults it to false.
        body: JSON.stringify({ host, port, allowLocalTunnel }),
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
        window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT))
        return { ok: true, device: data.device as DeviceSummary }
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
          window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT))
          return { ok: true, device: data.device as DeviceSummary }
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
        window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT))
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
