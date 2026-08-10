import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useDevices } from "@/hooks/useDevices"
import {
  __resetDeviceRevisionsForTest,
  getActiveDeviceId,
  getActiveDeviceScope,
  LOCAL_DEVICE_ID,
} from "@/lib/device"

const mocks = vi.hoisted(() => ({ hubFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ hubFetch: mocks.hubFetch }))

function json(body: unknown, options: { ok?: boolean; status?: number } = {}) {
  const ok = options.ok ?? true
  const status = options.status ?? (ok ? 200 : 400)
  return { ok, status, json: async () => body }
}

const DEVICE = {
  id: "dev_abc",
  name: "Studio",
  host: "10.0.0.5",
  port: 19384,
  auth: "password" as const,
  connectionRevision: 4,
  addedAt: 1,
  runtime: { authState: "ok" as const, lastHello: { version: "1.0.1" } },
}

describe("useDevices", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/")
    sessionStorage.clear()
    __resetDeviceRevisionsForTest()
    mocks.hubFetch.mockReset()
    mocks.hubFetch.mockImplementation((url: string) =>
      url === "/api/hub/devices"
        ? Promise.resolve(json({ devices: [DEVICE] }))
        : Promise.resolve(json({})),
    )
  })

  it("loads the device list from the hub on mount", async () => {
    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(mocks.hubFetch).toHaveBeenCalledWith("/api/hub/devices")
    expect(result.current.devices).toHaveLength(1)
    expect(result.current.devices[0].name).toBe("Studio")
    // The local device is active by default (jsdom path "/"), so no active remote.
    expect(result.current.activeDevice).toBeUndefined()
  })

  it("maps a failed probe to its typed code", async () => {
    mocks.hubFetch.mockImplementation((url: string) => {
      if (url === "/api/hub/devices") return Promise.resolve(json({ devices: [] }))
      if (url === "/api/hub/devices/probe") {
        return Promise.resolve(json({ ok: false, code: "SELF_ADD", error: "that's this machine" }))
      }
      return Promise.resolve(json({}))
    })

    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const probe = await result.current.probe("localhost", 19384)
    expect(probe).toEqual({ ok: false, code: "SELF_ADD", error: "that's this machine" })
    expect(mocks.hubFetch).toHaveBeenCalledWith(
      "/api/hub/devices/probe",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("forwards allowLocalTunnel in the probe body so a tunnel host isn't rejected as SSRF", async () => {
    mocks.hubFetch.mockImplementation((url: string) => {
      if (url === "/api/hub/devices") return Promise.resolve(json({ devices: [] }))
      return Promise.resolve(json({ ok: false, code: "UNREACHABLE" }))
    })

    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await result.current.probe("127.0.0.1", 19384, true)

    const probeCall = mocks.hubFetch.mock.calls.find(([url]) => url === "/api/hub/devices/probe")
    expect(probeCall).toBeDefined()
    expect(JSON.parse(probeCall![1].body as string)).toEqual({
      host: "127.0.0.1",
      port: 19384,
      allowLocalTunnel: true,
    })
  })

  it("adds a device and re-syncs the list via the change event", async () => {
    let listCalls = 0
    mocks.hubFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/hub/devices" && init?.method === "POST") {
        return Promise.resolve(json({ device: { id: "dev_new" } }, { status: 201 }))
      }
      if (url === "/api/hub/devices") {
        listCalls += 1
        return Promise.resolve(json({ devices: listCalls > 1 ? [DEVICE] : [] }))
      }
      return Promise.resolve(json({}))
    })

    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.devices).toHaveLength(0)

    let added: Awaited<ReturnType<typeof result.current.addDevice>> | undefined
    await act(async () => {
      added = await result.current.addDevice({
        host: "10.0.0.9",
        username: "alice",
        password: "hunter2hunter2",
      })
    })

    expect(added).toEqual({ ok: true, device: { id: "dev_new" } })
    const addCall = mocks.hubFetch.mock.calls.find(
      ([url, init]) => url === "/api/hub/devices" && init?.method === "POST",
    )
    expect(JSON.parse((addCall![1] as RequestInit).body as string)).toMatchObject({
      host: "10.0.0.9",
      username: "alice",
      password: "hunter2hunter2",
    })
    // The post dispatches "cogpit-devices-changed", which triggers a refresh.
    await waitFor(() => expect(result.current.devices).toHaveLength(1))
  })

  it("forwards an explicit username clear in a device patch", async () => {
    mocks.hubFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/hub/devices/dev_abc" && init?.method === "PATCH") {
        return Promise.resolve(json({ device: { ...DEVICE, username: undefined } }))
      }
      if (url === "/api/hub/devices") return Promise.resolve(json({ devices: [DEVICE] }))
      return Promise.resolve(json({}))
    })
    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.updateDevice("dev_abc", { username: null })
    })

    const patchCall = mocks.hubFetch.mock.calls.find(
      ([url, init]) => url === "/api/hub/devices/dev_abc" && init?.method === "PATCH",
    )
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ username: null })
  })

  it("publishes a new active scope only for a sensitive server revision", async () => {
    window.history.replaceState(null, "", "/d/dev_abc/")
    mocks.hubFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/hub/devices/dev_abc" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        return Promise.resolve(json({
          device: {
            ...DEVICE,
            name: typeof body.name === "string" ? body.name : DEVICE.name,
            connectionRevision: body.host ? 5 : 4,
          },
        }))
      }
      if (url === "/api/hub/devices") return Promise.resolve(json({ devices: [DEVICE] }))
      return Promise.resolve(json({}))
    })
    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.activeDevice?.connectionRevision).toBe(4))
    expect(getActiveDeviceScope()).toBe("dev_abc@4")
    const scopeChanged = vi.fn()
    window.addEventListener("cogpit-device-scope-changed", scopeChanged)

    await act(async () => { await result.current.updateDevice("dev_abc", { name: "Renamed" }) })
    expect(getActiveDeviceScope()).toBe("dev_abc@4")
    expect(scopeChanged).not.toHaveBeenCalled()

    await act(async () => { await result.current.updateDevice("dev_abc", { host: "10.0.0.9" }) })
    expect(getActiveDeviceScope()).toBe("dev_abc@5")
    expect(scopeChanged).toHaveBeenCalledOnce()
    window.removeEventListener("cogpit-device-scope-changed", scopeChanged)
  })

  it("refreshes another tab from the storage mutation signal and adopts its revision", async () => {
    window.history.replaceState(null, "", "/d/dev_abc/")
    let revision = 4
    mocks.hubFetch.mockImplementation((url: string) => {
      if (url === "/api/hub/devices") {
        return Promise.resolve(json({ devices: [{ ...DEVICE, connectionRevision: revision }] }))
      }
      return Promise.resolve(json({}))
    })
    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.activeDevice?.connectionRevision).toBe(4))

    revision = 5
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: "cogpit:devices-changed",
      newValue: JSON.stringify({ deviceId: "dev_abc", connectionRevision: 5 }),
    })))

    await waitFor(() => expect(result.current.activeDevice?.connectionRevision).toBe(5))
    expect(getActiveDeviceScope()).toBe("dev_abc@5")
  })

  it("switches another active tab to local when its device is removed", async () => {
    window.history.replaceState(null, "", "/d/dev_abc/session")
    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.activeDevice?.id).toBe("dev_abc"))

    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: "cogpit:devices-changed",
      newValue: JSON.stringify({ deviceId: "dev_abc", removed: true }),
    })))

    expect(getActiveDeviceId()).toBe(LOCAL_DEVICE_ID)
    expect(window.location.pathname).toBe("/")
  })

  it("switches to local before broadcasting removal of the active remote device", async () => {
    window.history.replaceState(null, "", "/d/dev_abc/session")
    let listCalls = 0
    mocks.hubFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/hub/devices/dev_abc" && init?.method === "DELETE") {
        return Promise.resolve(json({ success: true }))
      }
      if (url === "/api/hub/devices") {
        listCalls += 1
        return Promise.resolve(json({ devices: listCalls === 1 ? [DEVICE] : [] }))
      }
      return Promise.resolve(json({}))
    })
    let activeAtRegistryChange: string | null = null
    window.addEventListener("cogpit-devices-changed", () => {
      activeAtRegistryChange = getActiveDeviceId()
    }, { once: true })
    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.activeDevice?.id).toBe("dev_abc"))

    let removed: Awaited<ReturnType<typeof result.current.removeDevice>> | undefined
    await act(async () => {
      removed = await result.current.removeDevice("dev_abc")
    })

    expect(removed).toEqual({ ok: true })
    expect(getActiveDeviceId()).toBe(LOCAL_DEVICE_ID)
    expect(window.location.pathname).toBe("/")
    expect(activeAtRegistryChange).toBe(LOCAL_DEVICE_ID)
    await waitFor(() => expect(result.current.devices).toEqual([]))
    expect(result.current.activeDevice).toBeUndefined()
  })

  it.each(["cogpit-auth-changed", "cogpit-identity-changed"])(
    "re-fetches the root registry on %s",
    async (eventName) => {
      let listCalls = 0
      mocks.hubFetch.mockImplementation((url: string) => {
        if (url !== "/api/hub/devices") return Promise.resolve(json({}))
        listCalls += 1
        return Promise.resolve(json({ devices: listCalls > 1 ? [DEVICE] : [] }))
      })
      const { result } = renderHook(() => useDevices())
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.devices).toEqual([])

      act(() => window.dispatchEvent(new Event(eventName)))

      await waitFor(() => expect(result.current.devices).toEqual([DEVICE]))
      expect(listCalls).toBe(2)
    },
  )

  it("clears stale shortcuts on auth-required without recursively re-fetching", async () => {
    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.devices).toEqual([DEVICE]))
    const callsBefore = mocks.hubFetch.mock.calls.length

    act(() => window.dispatchEvent(new Event("cogpit-auth-required")))

    expect(result.current.devices).toEqual([])
    expect(result.current.loading).toBe(false)
    expect(mocks.hubFetch).toHaveBeenCalledTimes(callsBefore)
  })

  it("surfaces an add error with its code", async () => {
    mocks.hubFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/hub/devices" && init?.method === "POST") {
        return Promise.resolve(json({ error: "The password was rejected.", code: "BAD_PASSWORD" }, { ok: false }))
      }
      if (url === "/api/hub/devices") return Promise.resolve(json({ devices: [] }))
      return Promise.resolve(json({}))
    })

    const { result } = renderHook(() => useDevices())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const res = await result.current.addDevice({ host: "10.0.0.9", password: "wrong" })
    expect(res).toEqual({ ok: false, code: "BAD_PASSWORD", error: "The password was rejected." })
  })
})
