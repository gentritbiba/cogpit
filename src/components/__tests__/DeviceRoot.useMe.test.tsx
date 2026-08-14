import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DeviceRoot } from "@/components/DeviceRoot"
import { can, __resetCapabilitiesForTest } from "@/lib/capabilities"
import { getActiveIdentity, __resetIdentityForTest } from "@/lib/device"
import { MEMBER_CAPABILITIES, type MeResponse } from "../../../shared/contracts/team"

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  hubFetch: vi.fn(),
  appMounts: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ authFetch: mocks.authFetch, hubFetch: mocks.hubFetch }))
vi.mock("@/hooks/useDevices", () => ({
  useDevices: () => ({ devices: [], testDevice: vi.fn() }),
}))
vi.mock("@/contexts/SessionInventoryContext", () => ({
  SessionInventoryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/contexts/PendingHumanInputContext", () => ({
  PendingHumanInputProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/App", async () => {
  const { useState } = await import("react")
  const { useMe } = await import("@/hooks/useMe")
  return {
    default: function IdentityAppStub() {
      useState(() => {
        mocks.appMounts()
        return null
      })
      const me = useMe("team")
      return (
        <div data-testid="identity-state">
          {me.checked ? me.user?.id ?? "personal" : "unresolved"}
        </div>
      )
    },
  }
})

const MEMBER_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_1", username: "alice", displayName: "Alice", role: "member", createdAt: 1 },
  capabilities: MEMBER_CAPABILITIES,
}

function identityResponse(): Response {
  return new Response(JSON.stringify(MEMBER_ME), { status: 200 })
}

describe("DeviceRoot and useMe identity remount integration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState(null, "", "/")
    __resetIdentityForTest()
    __resetCapabilitiesForTest()
    mocks.hubFetch.mockImplementation(async () => identityResponse())
  })

  afterEach(() => {
    __resetIdentityForTest()
    __resetCapabilitiesForTest()
  })

  it("settles after the identity-keyed remount instead of toggling null and looping", async () => {
    render(<DeviceRoot />)

    await waitFor(() => expect(screen.getByTestId("identity-state")).toHaveTextContent("u_1"))
    // Initial null-identity mount, then exactly one u_1-keyed remount. The new
    // useMe instance must retain u_1 while it revalidates instead of emitting a
    // null identity and bouncing DeviceRoot back to the old key.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mocks.appMounts).toHaveBeenCalledTimes(2)
    expect(getActiveIdentity()).toBe("u_1")
    expect(can("terminal")).toBe(false)
  })

  it("still clears identity and capabilities on an explicit auth change", async () => {
    render(<DeviceRoot />)
    await waitFor(() => expect(getActiveIdentity()).toBe("u_1"))

    mocks.hubFetch.mockResolvedValue(new Response("unauthorized", { status: 401 }))
    act(() => window.dispatchEvent(new Event("cogpit-auth-changed")))

    await waitFor(() => expect(getActiveIdentity()).toBeNull())
    expect(screen.getByTestId("identity-state")).toHaveTextContent("unresolved")
    expect(can("terminal")).toBe(false)
  })
})
