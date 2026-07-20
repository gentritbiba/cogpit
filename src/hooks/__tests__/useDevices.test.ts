import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useDevices } from "@/hooks/useDevices"

const mocks = vi.hoisted(() => ({ hubFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ hubFetch: mocks.hubFetch }))

function json(body: unknown, { ok = true, status = ok ? 200 : 400 } = {}) {
  return { ok, status, json: async () => body }
}

const DEVICE = {
  id: "dev_abc",
  name: "Studio",
  host: "10.0.0.5",
  port: 19384,
  auth: "password" as const,
  addedAt: 1,
  runtime: { authState: "ok" as const, lastHello: { version: "1.0.1" } },
}

describe("useDevices", () => {
  beforeEach(() => {
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
      added = await result.current.addDevice({ host: "10.0.0.9", password: "hunter2hunter2" })
    })

    expect(added).toEqual({ ok: true, device: { id: "dev_new" } })
    // The post dispatches "cogpit-devices-changed", which triggers a refresh.
    await waitFor(() => expect(result.current.devices).toHaveLength(1))
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
