import { describe, it, expect, afterEach } from "vitest"
import { can, getAppGate, getCurrentUser, setMe, __resetCapabilitiesForTest } from "@/lib/capabilities"
import {
  ALL_CAPABILITIES,
  type Capabilities,
  type MeResponse,
  NO_CAPABILITIES,
} from "../../../shared/contracts/identity"

const MEMBER_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_1", username: "alice", displayName: "Alice" },
  capabilities: { ...NO_CAPABILITIES, manageWidgets: true },
  enforcesSessionAccess: true,
}
const UNRESOLVED_USER = { edition: null, user: null, hubUser: null, enforcesSessionAccess: null }
const MEMBER_USER = { edition: "team", user: MEMBER_ME.user, hubUser: MEMBER_ME.user, enforcesSessionAccess: true }

describe("capabilities", () => {
  afterEach(() => __resetCapabilitiesForTest())

  it("defaults every capability to true (personal parity — zero visual change)", () => {
    for (const cap of Object.keys(ALL_CAPABILITIES) as Array<keyof Capabilities>) {
      expect(can(cap)).toBe(true)
    }
  })

  it("reflects the capabilities /api/me reports, an edition's own included", () => {
    setMe(MEMBER_ME)
    expect(can("terminal")).toBe(false)
    expect(can("configWrite")).toBe(false)
    expect(can("manageDevices")).toBe(false)
    expect(can("killAny")).toBe(false)
    expect(can("share")).toBe(false)
    expect(can("manageWidgets")).toBe(true)
    expect(can("launchRockets")).toBe(false)
  })

  it("permits nothing and names no edition while the identity is unresolved", () => {
    setMe(MEMBER_ME)
    setMe(null)
    for (const cap of Object.keys(ALL_CAPABILITIES) as Array<keyof Capabilities>) {
      expect(can(cap)).toBe(false)
    }
    expect(getCurrentUser()).toEqual(UNRESOLVED_USER)
  })

  it("mirrors the signed-in user, edition and session-access check beside the capabilities", () => {
    expect(getCurrentUser()).toEqual({ edition: "personal", user: null, hubUser: null, enforcesSessionAccess: false })

    setMe(MEMBER_ME)
    expect(getCurrentUser()).toEqual(MEMBER_USER)
  })

  it("names the hub's own account beside the account it holds on a remote device", () => {
    const hubUser = { ...MEMBER_ME.user!, id: "u_hub", username: "hub" }
    setMe({ authenticated: true, edition: "personal", user: null, capabilities: ALL_CAPABILITIES }, hubUser)

    expect(getCurrentUser()).toEqual({ edition: "personal", user: null, hubUser, enforcesSessionAccess: false })
  })

  it("keeps an identity to the device it was read from", () => {
    setMe(MEMBER_ME)
    window.history.replaceState(null, "", "/d/other-device/")

    expect(getCurrentUser()).toEqual(UNRESOLVED_USER)
    expect(can("manageWidgets")).toBe(false)

    window.history.replaceState(null, "", "/")
    expect(getCurrentUser()).toEqual(MEMBER_USER)
    expect(can("manageWidgets")).toBe(true)
  })

  it("names the gate /api/me reports, for the device it was read from", () => {
    expect(getAppGate()).toBeNull()

    setMe({ ...MEMBER_ME, capabilities: ALL_CAPABILITIES, gate: "on_hold" })
    expect(getAppGate()).toBe("on_hold")

    window.history.replaceState(null, "", "/d/other-device/")
    expect(getAppGate()).toBeNull()
    window.history.replaceState(null, "", "/")

    setMe(null)
    expect(getAppGate()).toBeNull()
  })
})
