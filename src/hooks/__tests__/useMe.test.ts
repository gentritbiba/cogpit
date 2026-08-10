import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  hubFetch: vi.fn(),
}))

import { authFetch, hubFetch } from "@/lib/auth"
import { useMe } from "@/hooks/useMe"
import { can, __resetCapabilitiesForTest } from "@/lib/capabilities"
import { deviceScopedKey, getActiveIdentity, __resetIdentityForTest } from "@/lib/device"
import {
  ALL_CAPABILITIES,
  MEMBER_CAPABILITIES,
  NO_CAPABILITIES,
  type MeResponse,
} from "../../../shared/contracts/team"

const mockedAuthFetch = vi.mocked(authFetch)
const mockedHubFetch = vi.mocked(hubFetch)

const MEMBER_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_1", username: "alice", displayName: "Alice", role: "member", createdAt: 1 },
  capabilities: MEMBER_CAPABILITIES,
}

const ADMIN_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "outer-admin", username: "owner", displayName: "Owner", role: "admin", createdAt: 1 },
  capabilities: ALL_CAPABILITIES,
}

/** Fresh Response per call — /api/me is fetched more than once per mount cycle. */
function mockMeResponse(me: MeResponse) {
  mockedHubFetch.mockImplementation(
    async () => new Response(JSON.stringify(me), { status: 200 }),
  )
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
      edition: "personal",
      user: null,
      capabilities: NO_CAPABILITIES,
      checked: false,
    })
    expect(can("terminal")).toBe(false)
    await waitFor(() => expect(mockedHubFetch).toHaveBeenCalledWith("/api/me", expect.anything()))
  })

  it("adopts the server identity, capabilities, and storage scope on success", async () => {
    mockMeResponse(MEMBER_ME)
    const { result } = renderHook(() => useMe("team"))

    await waitFor(() => expect(result.current.user?.id).toBe("u_1"))
    expect(result.current.checked).toBe(true)
    expect(result.current.edition).toBe("team")
    expect(result.current.capabilities).toEqual(MEMBER_CAPABILITIES)
    expect(can("terminal")).toBe(false)
    expect(deviceScopedKey("cogpit:permissions")).toBe("cogpit:permissions::local::u_1")
  })

  it("re-fetches the identity when auth state changes", async () => {
    mockMeResponse(MEMBER_ME)
    const { result } = renderHook(() => useMe("team"))
    await waitFor(() => expect(result.current.user?.id).toBe("u_1"))

    const adminMe: MeResponse = {
      ...MEMBER_ME,
      user: { ...MEMBER_ME.user!, id: "u_2", username: "bob", role: "admin" },
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

  it("remains unresolved and zero-capability when a known team identity fetch fails", async () => {
    mockMeResponse(MEMBER_ME)
    const { result } = renderHook(() => useMe("team"))
    await waitFor(() => expect(can("terminal")).toBe(false))

    mockedHubFetch.mockRejectedValue(new Error("Authentication required"))
    act(() => window.dispatchEvent(new Event("cogpit-auth-changed")))

    await waitFor(() => expect(result.current.user).toBeNull())
    expect(result.current.checked).toBe(false)
    expect(result.current.capabilities).toEqual(NO_CAPABILITIES)
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

  it("keeps the team hub member ready and authoritative on a personal remote device", async () => {
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
    expect(result.current.edition).toBe("team")
    expect(result.current.user?.id).toBe("u_1")
    expect(result.current.capabilities).toEqual(MEMBER_CAPABILITIES)
    expect(can("terminal")).toBe(false)
    expect(deviceScopedKey("cache")).toBe("cache::personal-device::u_1")
  })

  it("does not adopt a team remote device's admin service identity or capabilities", async () => {
    window.history.replaceState(null, "", "/d/team-device/")
    const remoteAdmin: MeResponse = {
      authenticated: true,
      edition: "team",
      user: { id: "remote-admin", username: "service", displayName: "Service", role: "admin", createdAt: 2 },
      capabilities: ALL_CAPABILITIES,
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
    expect(result.current.user?.id).toBe("u_1")
    expect(result.current.user?.role).toBe("member")
    expect(result.current.capabilities).toEqual(MEMBER_CAPABILITIES)
    expect(can("configWrite")).toBe(false)
    expect(deviceScopedKey("cache")).toBe("cache::team-device::u_1")
  })

  it("revalidates an active remote account change without clearing the origin cache identity", async () => {
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
    expect(result.current.capabilities).toEqual(ALL_CAPABILITIES)
    expect(getActiveIdentity()).toBe("outer-admin")

    act(() => window.dispatchEvent(new CustomEvent("cogpit-devices-changed", {
      detail: { deviceId: "active-device" },
    })))

    expect(result.current.checked).toBe(false)
    expect(result.current.user?.id).toBe("outer-admin")
    expect(result.current.capabilities).toEqual(NO_CAPABILITIES)
    expect(can("terminal")).toBe(false)
    expect(getActiveIdentity()).toBe("outer-admin")
    expect(deviceScopedKey("cache")).toBe("cache::active-device::outer-admin")

    await waitFor(() => expect(remoteMeCalls).toBe(2))
    finishRemoteRevalidation(new Response(JSON.stringify(remoteMember), { status: 200 }))
    await waitFor(() => expect(result.current.checked).toBe(true))
    expect(result.current.user?.id).toBe("outer-admin")
    expect(result.current.capabilities).toEqual(MEMBER_CAPABILITIES)
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
