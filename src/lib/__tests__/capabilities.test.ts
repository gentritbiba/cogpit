import { describe, it, expect, afterEach } from "vitest"
import { can, setMe, __resetCapabilitiesForTest } from "@/lib/capabilities"
import {
  ALL_CAPABILITIES,
  MEMBER_CAPABILITIES,
  type Capabilities,
  type MeResponse,
} from "../../../shared/contracts/team"

const MEMBER_ME: MeResponse = {
  authenticated: true,
  edition: "team",
  user: { id: "u_1", username: "alice", displayName: "Alice", role: "member", createdAt: 1 },
  capabilities: MEMBER_CAPABILITIES,
}

describe("capabilities", () => {
  afterEach(() => __resetCapabilitiesForTest())

  it("defaults every capability to true (personal parity — zero visual change)", () => {
    for (const cap of Object.keys(ALL_CAPABILITIES) as Array<keyof Capabilities>) {
      expect(can(cap)).toBe(true)
    }
  })

  it("reflects member capabilities after setMe", () => {
    setMe(MEMBER_ME)
    expect(can("terminal")).toBe(false)
    expect(can("configWrite")).toBe(false)
    expect(can("manageDevices")).toBe(false)
    expect(can("killAny")).toBe(false)
    expect(can("share")).toBe(true)
    expect(can("runFlows")).toBe(true)
  })

  it("returns to all-capabilities when the identity is cleared", () => {
    setMe(MEMBER_ME)
    setMe(null)
    for (const cap of Object.keys(ALL_CAPABILITIES) as Array<keyof Capabilities>) {
      expect(can(cap)).toBe(true)
    }
  })
})
