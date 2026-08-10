import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { useMe } from "@/hooks/useMe"
import { can, __resetCapabilitiesForTest } from "@/lib/capabilities"
import { deviceScopedKey, __resetIdentityForTest } from "@/lib/device"
import {
  ALL_CAPABILITIES,
  MEMBER_CAPABILITIES,
  type MeResponse,
} from "../../../shared/contracts/team"

const mockedAuthFetch = vi.mocked(authFetch)

const MEMBER_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_1", username: "alice", displayName: "Alice", role: "member", createdAt: 1 },
  capabilities: MEMBER_CAPABILITIES,
}

/** Fresh Response per call — /api/me is fetched more than once per mount cycle. */
function mockMeResponse(me: MeResponse) {
  mockedAuthFetch.mockImplementation(
    async () => new Response(JSON.stringify(me), { status: 200 }),
  )
}

describe("useMe", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    __resetCapabilitiesForTest()
    __resetIdentityForTest()
  })

  it("serves personal-parity defaults while /api/me is in flight", () => {
    mockedAuthFetch.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useMe())

    expect(result.current).toEqual({
      authenticated: true,
      edition: "personal",
      user: null,
      capabilities: ALL_CAPABILITIES,
    })
    expect(can("terminal")).toBe(true)
    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/me", expect.anything())
  })

  it("adopts the server identity, capabilities, and storage scope on success", async () => {
    mockMeResponse(MEMBER_ME)
    const { result } = renderHook(() => useMe())

    await waitFor(() => expect(result.current.user?.id).toBe("u_1"))
    expect(result.current.edition).toBe("team")
    expect(result.current.capabilities).toEqual(MEMBER_CAPABILITIES)
    expect(can("terminal")).toBe(false)
    expect(deviceScopedKey("cogpit:permissions")).toBe("cogpit:permissions::local::u_1")
  })

  it("re-fetches the identity when auth state changes", async () => {
    mockMeResponse(MEMBER_ME)
    const { result } = renderHook(() => useMe())
    await waitFor(() => expect(result.current.user?.id).toBe("u_1"))

    const adminMe: MeResponse = {
      ...MEMBER_ME,
      user: { ...MEMBER_ME.user!, id: "u_2", username: "bob", role: "admin" },
      capabilities: ALL_CAPABILITIES,
    }
    mockMeResponse(adminMe)
    act(() => window.dispatchEvent(new Event("cogpit-auth-changed")))

    await waitFor(() => expect(result.current.user?.id).toBe("u_2"))
    expect(can("terminal")).toBe(true)
    expect(deviceScopedKey("k")).toBe("k::local::u_2")
    expect(mockedAuthFetch).toHaveBeenCalledTimes(2)
  })

  it("falls back to personal parity when the identity fetch fails", async () => {
    mockMeResponse(MEMBER_ME)
    const { result } = renderHook(() => useMe())
    await waitFor(() => expect(can("terminal")).toBe(false))

    mockedAuthFetch.mockRejectedValue(new Error("Authentication required"))
    act(() => window.dispatchEvent(new Event("cogpit-auth-changed")))

    await waitFor(() => expect(result.current.user).toBeNull())
    expect(result.current.capabilities).toEqual(ALL_CAPABILITIES)
    expect(can("terminal")).toBe(true)
    expect(deviceScopedKey("k")).toBe("k")
  })

  it("treats a non-OK /api/me as a failure, not an identity", async () => {
    mockedAuthFetch.mockImplementation(
      async () => new Response("Admin access required", { status: 403 }),
    )
    const { result } = renderHook(() => useMe())

    await waitFor(() => expect(mockedAuthFetch).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.capabilities).toEqual(ALL_CAPABILITIES))
    expect(result.current.user).toBeNull()
  })
})
