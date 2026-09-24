import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  hubFetch: vi.fn(),
}))

import { hubFetch } from "@/lib/auth"
import { useCurrentUser } from "@/hooks/useCurrentUser"
import { useMe } from "@/hooks/useMe"
import { __resetCapabilitiesForTest } from "@/lib/capabilities"
import { __resetIdentityForTest } from "@/lib/device"
import { type MeResponse, NO_CAPABILITIES } from "../../../shared/contracts/identity"

const MEMBER_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_1", username: "alice", displayName: "Alice" },
  capabilities: NO_CAPABILITIES,
  enforcesSessionAccess: true,
}

describe("useCurrentUser", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    window.history.replaceState(null, "", "/")
    vi.mocked(hubFetch).mockImplementation(
      async () => new Response(JSON.stringify(MEMBER_ME), { status: 200 }),
    )
  })

  afterEach(() => {
    __resetCapabilitiesForTest()
    __resetIdentityForTest()
  })

  it("reads the identity useMe resolved from /api/me without fetching again", async () => {
    renderHook(() => useMe("team"))
    const { result } = renderHook(() => useCurrentUser())

    await waitFor(() => expect(result.current.user?.id).toBe("u_1"))
    expect(result.current.edition).toBe("team")
    expect(vi.mocked(hubFetch)).toHaveBeenCalledOnce()
  })

  it("re-renders when the identity is cleared by a login change", async () => {
    vi.mocked(hubFetch).mockImplementationOnce(
      async () => new Response(JSON.stringify(MEMBER_ME), { status: 200 }),
    ).mockReturnValue(new Promise(() => {}))
    renderHook(() => useMe("team"))
    const { result } = renderHook(() => useCurrentUser())
    await waitFor(() => expect(result.current.user?.id).toBe("u_1"))

    act(() => {
      window.dispatchEvent(new Event("cogpit-auth-changed"))
    })

    expect(result.current.user).toBeNull()
  })

  it("stays personal with no user until a team identity resolves", () => {
    const { result } = renderHook(() => useCurrentUser())
    expect(result.current).toEqual({ edition: "personal", user: null, hubUser: null, enforcesSessionAccess: false })
  })
})
