import { afterEach, describe, expect, it } from "vitest"
import { renderHook } from "@testing-library/react"
import { useListedPermissions } from "@/hooks/useListedPermissions"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { permissionsForAccess } from "@/lib/sessionAccessPermissions"
import { NO_CAPABILITIES } from "../../../shared/contracts/identity"

const ALICE = { id: "u_alice", username: "alice", displayName: "Alice" }

describe("useListedPermissions", () => {
  afterEach(() => __resetCapabilitiesForTest())

  it("treats a personal-edition row, which carries no access, as the user's own", () => {
    const { result } = renderHook(() => useListedPermissions())

    expect(result.current(undefined)).toBe(permissionsForAccess("own"))
  })

  it("leaves every row read-only while the identity is unresolved", () => {
    setMe(null)
    const { result } = renderHook(() => useListedPermissions())

    expect(result.current(undefined)).toBe(permissionsForAccess("unknown"))
    expect(result.current({ level: "own", mine: true }))
      .toBe(permissionsForAccess("unknown"))
  })

  it("reads each team row's own level and leaves a row without one read-only", () => {
    setMe({
      authenticated: true,
      edition: "team",
      user: { ...ALICE },
      capabilities: NO_CAPABILITIES,
      enforcesSessionAccess: true,
    })
    const { result } = renderHook(() => useListedPermissions())

    expect(result.current({ level: "interact", mine: false }))
      .toBe(permissionsForAccess("interact"))
    expect(result.current(undefined)).toBe(permissionsForAccess("unknown"))
  })
})
