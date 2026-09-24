import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  hubFetch: vi.fn(),
}))

import { authFetch, hubFetch } from "@/lib/auth"
import { useMe } from "@/hooks/useMe"
import { announceGate } from "@/lib/gateEvents"
import { can, getCurrentUser, __resetCapabilitiesForTest } from "@/lib/capabilities"
import { deviceScopedKey, getActiveIdentity, __resetIdentityForTest } from "@/lib/device"
import { ALL_CAPABILITIES, GATE_HEADER, type MeResponse, NO_CAPABILITIES } from "../../../shared/contracts/identity"

const mockedAuthFetch = vi.mocked(authFetch)
const mockedHubFetch = vi.mocked(hubFetch)

const MEMBER_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_1", username: "alice", displayName: "Alice" },
  capabilities: NO_CAPABILITIES,
  enforcesSessionAccess: true,
}

const ADMIN_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "outer-admin", username: "owner", displayName: "Owner" },
  capabilities: ALL_CAPABILITIES,
  enforcesSessionAccess: true,
}

/** Fresh Response per call — /api/me is fetched more than once per mount cycle. */
function mockMeResponse(me: MeResponse) {
  mockedHubFetch.mockImplementation(
    async () => new Response(JSON.stringify(me), { status: 200 }),
  )
}

/** Some other request of the app's, refused because the server now keeps the caller out. */
function refuseBehindTheGate() {
  act(() => announceGate(new Response("{}", { status: 403, headers: { [GATE_HEADER]: "paused" } })))
}

describe("useMe", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    window.history.replaceState(null, "", "/")
  })

  afterEach(() => {
    __resetCapabilitiesForTest()
    __resetIdentityForTest()
  })

  it("stays fail-closed while a known team identity is in flight", async () => {
    mockedHubFetch.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useMe("team"))

    expect(result.current).toEqual({
      authenticated: false,
      edition: null,
      user: null,
      capabilities: NO_CAPABILITIES,
      checked: false,
    })
    expect(getCurrentUser().edition).toBeNull()
    expect(can("terminal")).toBe(false)
    await waitFor(() => expect(mockedHubFetch).toHaveBeenCalledWith("/api/me", expect.anything()))
  })

  it("adopts the server identity, capabilities, and storage scope on success", async () => {
    mockMeResponse(MEMBER_ME)
    const { result } = renderHook(() => useMe("team"))

    await waitFor(() => expect(result.current.user?.id).toBe("u_1"))
    expect(result.current.checked).toBe(true)
    expect(result.current.edition).toBe("team")
    expect(result.current.capabilities).toEqual(NO_CAPABILITIES)
    expect(can("terminal")).toBe(false)
    expect(deviceScopedKey("cogpit:permissions")).toBe("cogpit:permissions::local::u_1")
  })

  it("gives an account the Browser panel without host files, as the server narrows it per browser", async () => {
    mockMeResponse({ ...MEMBER_ME, capabilities: { ...NO_CAPABILITIES, browser: true } })
    renderHook(() => useMe("team"))

    await waitFor(() => expect(getCurrentUser().user?.id).toBe("u_1"))
    expect(can("browser")).toBe(true)
    expect(can("hostFiles")).toBe(false)
  })

  it("reads the Browser panel off host files on a server from before its own capability", async () => {
    const { browser: _browser, ...older } = NO_CAPABILITIES
    mockMeResponse({ ...MEMBER_ME, capabilities: older as typeof NO_CAPABILITIES })
    const { result } = renderHook(() => useMe("team"))

    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.user?.id).toBe("u_1")
    expect(can("browser")).toBe(false)
  })

  it("re-fetches the identity when auth state changes", async () => {
    mockMeResponse(MEMBER_ME)
    const { result } = renderHook(() => useMe("team"))
    await waitFor(() => expect(result.current.user?.id).toBe("u_1"))

    const adminMe: MeResponse = {
      ...MEMBER_ME,
      user: { ...MEMBER_ME.user!, id: "u_2", username: "bob" },
      capabilities: ALL_CAPABILITIES,
    }
    mockMeResponse(adminMe)
    act(() => window.dispatchEvent(new Event("cogpit-auth-changed")))

    expect(result.current.checked).toBe(false)

    await waitFor(() => expect(result.current.user?.id).toBe("u_2"))
    expect(can("terminal")).toBe(true)
    expect(deviceScopedKey("k")).toBe("k::local::u_2")
    expect(mockedHubFetch).toHaveBeenCalledTimes(2)
  })

  it("carries the gate that keeps the caller out", async () => {
    mockMeResponse({ ...ADMIN_ME, gate: "on_hold" })
    const { result } = renderHook(() => useMe("team"))

    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.gate).toBe("on_hold")
  })

  it("carries a remote device's gate, which the hub's account there meets", async () => {
    window.history.replaceState(null, "", "/d/team-device/")
    mockMeResponse(ADMIN_ME)
    const lockedDevice: MeResponse = { ...ADMIN_ME, gate: "paused" }
    mockedAuthFetch.mockImplementation(async (url) => new Response(
      JSON.stringify(url === "/api/hello" ? { edition: "team" } : lockedDevice),
      { status: 200 },
    ))

    const { result } = renderHook(() => useMe("team"))

    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.gate).toBe("paused")
  })

  it("returns to this machine when its own gate stops it reaching any device", async () => {
    window.history.replaceState(null, "", "/d/team-device/")
    mockMeResponse({ ...ADMIN_ME, gate: "paused" })
    mockedAuthFetch.mockImplementation(async () => new Response("{}", { status: 403 }))
    const switched = vi.fn()
    window.addEventListener("cogpit-device-changed", switched)

    renderHook(() => useMe("team"))

    await waitFor(() => expect(switched).toHaveBeenCalledOnce())
    expect(window.location.pathname).toBe("/")
    window.removeEventListener("cogpit-device-changed", switched)
  })

  it("reads the identity again when another request is refused behind the gate, to show it", async () => {
    mockMeResponse(ADMIN_ME)
    const { result } = renderHook(() => useMe("team"))
    await waitFor(() => expect(result.current.checked).toBe(true))

    mockMeResponse({ ...ADMIN_ME, gate: "paused" })
    refuseBehindTheGate()

    await waitFor(() => expect(result.current.gate).toBe("paused"))
    expect(result.current.user?.id).toBe("outer-admin")
    expect(mockedHubFetch).toHaveBeenCalledTimes(2)
  })

  it("does not read it again while it already names the gate", async () => {
    mockMeResponse({ ...ADMIN_ME, gate: "paused" })
    const { result } = renderHook(() => useMe("team"))
    await waitFor(() => expect(result.current.gate).toBe("paused"))

    refuseBehindTheGate()

    expect(result.current.checked).toBe(true)
    expect(mockedHubFetch).toHaveBeenCalledOnce()
  })

  it("returns to this machine when its own gate starts refusing a remote device's requests", async () => {
    window.history.replaceState(null, "", "/d/team-device/")
    mockMeResponse(ADMIN_ME)
    mockedAuthFetch.mockImplementation(async (url) => new Response(
      JSON.stringify(url === "/api/hello" ? { edition: "team" } : ADMIN_ME),
      { status: 200 },
    ))
    const { result } = renderHook(() => useMe("team"))
    await waitFor(() => expect(result.current.checked).toBe(true))
    const switched = vi.fn()
    window.addEventListener("cogpit-device-changed", switched)

    mockMeResponse({ ...ADMIN_ME, gate: "paused" })
    refuseBehindTheGate()

    await waitFor(() => expect(switched).toHaveBeenCalledOnce())
    expect(window.location.pathname).toBe("/")
    window.removeEventListener("cogpit-device-changed", switched)
  })

  it("remains unresolved and zero-capability when a known team identity fetch fails", async () => {
    mockMeResponse(MEMBER_ME)
    const { result } = renderHook(() => useMe("team"))
    await waitFor(() => expect(can("terminal")).toBe(false))

    mockedHubFetch.mockRejectedValue(new Error("Authentication required"))
    act(() => window.dispatchEvent(new Event("cogpit-auth-changed")))

    await waitFor(() => expect(result.current.user).toBeNull())
    expect(result.current.checked).toBe(false)
    expect(result.current.capabilities).toEqual(NO_CAPABILITIES)
    expect(getCurrentUser().edition).toBeNull()
    expect(can("terminal")).toBe(false)
    expect(deviceScopedKey("k")).toBe("k")
  })

  it("preserves personal parity when /api/me is unavailable on a personal server", async () => {
    mockedHubFetch.mockRejectedValue(new Error("Unavailable"))
    const { result } = renderHook(() => useMe("personal"))

    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.capabilities).toEqual(ALL_CAPABILITIES)
    expect(can("terminal")).toBe(true)
  })

  it("fails closed for a team remote device even when the hub is personal", async () => {
    window.history.replaceState(null, "", "/d/team-device/")
    mockedHubFetch.mockResolvedValue(
      new Response(JSON.stringify({
        authenticated: true,
        edition: "personal",
        user: null,
        capabilities: ALL_CAPABILITIES,
      }), { status: 200 }),
    )
    mockedAuthFetch.mockImplementation(async (url) => {
      if (url === "/api/hello") {
        return new Response(JSON.stringify({ edition: "team" }), { status: 200 })
      }
      return new Response("Identity unavailable", { status: 500 })
    })
    const { result } = renderHook(() => useMe("personal"))

    await waitFor(() => expect(mockedAuthFetch).toHaveBeenCalledWith("/api/me", expect.anything()))
    expect(result.current.checked).toBe(false)
    expect(result.current.capabilities).toEqual(NO_CAPABILITIES)
  })

  it("treats a non-OK /api/me as a failure, not an identity", async () => {
    mockedHubFetch.mockImplementation(
      async () => new Response("Admin access required", { status: 403 }),
    )
    const { result } = renderHook(() => useMe("team"))

    await waitFor(() => expect(mockedHubFetch).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.capabilities).toEqual(NO_CAPABILITIES))
    expect(result.current.checked).toBe(false)
    expect(result.current.user).toBeNull()
  })

  it("follows a personal remote device: no team identity, storage still scoped to the hub user", async () => {
    window.history.replaceState(null, "", "/d/personal-device/")
    mockedHubFetch.mockResolvedValue(
      new Response(JSON.stringify(MEMBER_ME), { status: 200 }),
    )
    mockedAuthFetch.mockImplementation(async (url) => {
      if (url === "/api/hello") {
        return new Response(JSON.stringify({ edition: "personal" }), { status: 200 })
      }
      return new Response(JSON.stringify({
        authenticated: true,
        edition: "personal",
        user: null,
        capabilities: ALL_CAPABILITIES,
      }), { status: 200 })
    })

    const { result } = renderHook(() => useMe("team"))

    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.edition).toBe("personal")
    expect(result.current.user).toBeNull()
    // The hub checks session access; the personal device it looks at does not.
    expect(getCurrentUser()).toEqual({
      edition: "personal",
      user: null,
      hubUser: MEMBER_ME.user,
      enforcesSessionAccess: false,
    })
    expect(result.current.capabilities).toEqual(NO_CAPABILITIES)
    expect(can("terminal")).toBe(false)
    expect(deviceScopedKey("cache")).toBe("cache::personal-device::u_1")
  })

  it("adopts a team device's account there, narrowed to what the hub user may do", async () => {
    window.history.replaceState(null, "", "/d/team-device/")
    const remoteAdmin: MeResponse = {
      authenticated: true,
      edition: "team",
      user: { id: "remote-admin", username: "service", displayName: "Service" },
      capabilities: ALL_CAPABILITIES,
      enforcesSessionAccess: true,
    }
    mockedHubFetch.mockResolvedValue(
      new Response(JSON.stringify(MEMBER_ME), { status: 200 }),
    )
    mockedAuthFetch.mockImplementation(async (url) => new Response(
      JSON.stringify(url === "/api/hello" ? { edition: "team" } : remoteAdmin),
      { status: 200 },
    ))

    const { result } = renderHook(() => useMe("team"))

    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.user?.id).toBe("remote-admin")
    expect(getCurrentUser()).toEqual({
      edition: "team",
      user: remoteAdmin.user,
      hubUser: MEMBER_ME.user,
      enforcesSessionAccess: true,
    })
    expect(result.current.capabilities).toEqual(NO_CAPABILITIES)
    expect(can("configWrite")).toBe(false)
    expect(deviceScopedKey("cache")).toBe("cache::team-device::u_1")
  })

  it("gives a personal hub the team edition of a team device it looks at", async () => {
    window.history.replaceState(null, "", "/d/team-device/")
    mockedHubFetch.mockResolvedValue(new Response(JSON.stringify({
      authenticated: true,
      edition: "personal",
      user: null,
      capabilities: ALL_CAPABILITIES,
    }), { status: 200 }))
    mockedAuthFetch.mockImplementation(async (url) => new Response(
      JSON.stringify(url === "/api/hello" ? { edition: "team" } : MEMBER_ME),
      { status: 200 },
    ))

    const { result } = renderHook(() => useMe("personal"))

    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(getCurrentUser()).toEqual({ edition: "team", user: MEMBER_ME.user, hubUser: null, enforcesSessionAccess: true })
    expect(result.current.capabilities).toEqual(NO_CAPABILITIES)
    expect(getActiveIdentity()).toBeNull()
    expect(deviceScopedKey("cache")).toBe("cache::team-device")
  })

  it("keeps a capability the device's edition adds unless the hub denies it", async () => {
    window.history.replaceState(null, "", "/d/team-device/")
    const remote: MeResponse = {
      ...MEMBER_ME,
      capabilities: { ...ALL_CAPABILITIES, manageWidgets: true, launchRockets: true, viewAudit: false },
    }
    mockedHubFetch.mockResolvedValue(new Response(JSON.stringify({
      ...MEMBER_ME,
      capabilities: { ...ALL_CAPABILITIES, launchRockets: false },
    }), { status: 200 }))
    mockedAuthFetch.mockImplementation(async (url) => new Response(
      JSON.stringify(url === "/api/hello" ? { edition: "team" } : remote),
      { status: 200 },
    ))

    const { result } = renderHook(() => useMe("team"))

    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.capabilities).toEqual({ ...ALL_CAPABILITIES, manageWidgets: true, launchRockets: false, viewAudit: false })
    expect(can("manageWidgets")).toBe(true)
    expect(can("launchRockets")).toBe(false)
  })

  it("revalidates an active remote account change without clearing the hub's storage identity", async () => {
    window.history.replaceState(null, "", "/d/active-device/")
    mockedHubFetch.mockImplementation(async () =>
      new Response(JSON.stringify(ADMIN_ME), { status: 200 }))
    const remoteAdmin: MeResponse = {
      ...ADMIN_ME,
      user: { ...ADMIN_ME.user!, id: "remote-admin", username: "service-admin" },
    }
    const remoteMember: MeResponse = {
      ...MEMBER_ME,
      user: { ...MEMBER_ME.user!, id: "remote-member", username: "service-member" },
    }
    let finishRemoteRevalidation!: (response: Response) => void
    let remoteMeCalls = 0
    mockedAuthFetch.mockImplementation(async (url) => {
      if (url === "/api/hello") {
        return new Response(JSON.stringify({ edition: "team" }), { status: 200 })
      }
      remoteMeCalls += 1
      if (remoteMeCalls === 1) {
        return new Response(JSON.stringify(remoteAdmin), { status: 200 })
      }
      return new Promise<Response>((resolve) => {
        finishRemoteRevalidation = resolve
      })
    })

    const { result } = renderHook(() => useMe("team"))
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.user?.id).toBe("remote-admin")
    expect(result.current.capabilities).toEqual(ALL_CAPABILITIES)
    expect(getActiveIdentity()).toBe("outer-admin")

    act(() => window.dispatchEvent(new CustomEvent("cogpit-devices-changed", {
      detail: { deviceId: "active-device" },
    })))

    expect(result.current.checked).toBe(false)
    expect(result.current.user?.id).toBe("remote-admin")
    expect(result.current.capabilities).toEqual(NO_CAPABILITIES)
    expect(getCurrentUser().edition).toBeNull()
    expect(can("terminal")).toBe(false)
    expect(getActiveIdentity()).toBe("outer-admin")
    expect(deviceScopedKey("cache")).toBe("cache::active-device::outer-admin")

    await waitFor(() => expect(remoteMeCalls).toBe(2))
    finishRemoteRevalidation(new Response(JSON.stringify(remoteMember), { status: 200 }))
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.user?.id).toBe("remote-member")
    expect(result.current.capabilities).toEqual(NO_CAPABILITIES)
    expect(getActiveIdentity()).toBe("outer-admin")
    expect(deviceScopedKey("cache")).toBe("cache::active-device::outer-admin")
  })

  it("ignores registry updates for a non-active remote device", async () => {
    window.history.replaceState(null, "", "/d/active-device/")
    mockedHubFetch.mockResolvedValue(new Response(JSON.stringify(ADMIN_ME), { status: 200 }))
    mockedAuthFetch.mockImplementation(async (url) => new Response(JSON.stringify(
      url === "/api/hello" ? { edition: "team" } : ADMIN_ME,
    ), { status: 200 }))
    const { result } = renderHook(() => useMe("team"))
    await waitFor(() => expect(result.current.checked).toBe(true))
    const hubCalls = mockedHubFetch.mock.calls.length
    const targetCalls = mockedAuthFetch.mock.calls.length

    await act(async () => {
      window.dispatchEvent(new CustomEvent("cogpit-devices-changed", {
        detail: { deviceId: "other-device" },
      }))
      await Promise.resolve()
    })

    expect(result.current.checked).toBe(true)
    expect(mockedHubFetch).toHaveBeenCalledTimes(hubCalls)
    expect(mockedAuthFetch).toHaveBeenCalledTimes(targetCalls)
  })

  it("ignores remote registry updates while the local device is active", async () => {
    mockedHubFetch.mockResolvedValue(new Response(JSON.stringify(ADMIN_ME), { status: 200 }))
    const { result } = renderHook(() => useMe("team"))
    await waitFor(() => expect(result.current.checked).toBe(true))

    await act(async () => {
      window.dispatchEvent(new CustomEvent("cogpit-devices-changed", {
        detail: { deviceId: "remote-device" },
      }))
      await Promise.resolve()
    })

    expect(result.current.checked).toBe(true)
    expect(mockedHubFetch).toHaveBeenCalledOnce()
    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })
})
