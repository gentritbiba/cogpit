import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useProjectFileSuggestions } from "@/hooks/useProjectFileSuggestions"
import { useScriptDiscovery } from "@/hooks/useScriptDiscovery"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { MEMBER_CAPABILITIES } from "../../../shared/contracts/team"

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }))
vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch }))

function becomeMember(): void {
  act(() => setMe({
    authenticated: true,
    edition: "team",
    user: { id: "u_member", username: "member", displayName: "Member", role: "member", createdAt: 1 },
    capabilities: MEMBER_CAPABILITIES,
  }))
}

describe("host-file capability fetch gates", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetCapabilitiesForTest()
  })

  afterEach(() => __resetCapabilitiesForTest())

  it("does not query project-file suggestions for a member", () => {
    becomeMember()
    const { result } = renderHook(() =>
      useProjectFileSuggestions("/workspace", "app", true)
    )

    expect(result.current).toEqual({ files: [], loading: false })
    expect(mocks.authFetch).not.toHaveBeenCalled()
  })

  it("does not discover scripts for a member", () => {
    becomeMember()
    const { result } = renderHook(() => useScriptDiscovery("/workspace"))

    expect(result.current).toMatchObject({ scripts: [], loading: false })
    expect(mocks.authFetch).not.toHaveBeenCalled()
  })
})
