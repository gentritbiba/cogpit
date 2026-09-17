import { describe, expect, it } from "vitest"
import { adjacentMobileTab, MOBILE_TAB_ORDER } from "../mobileView"

describe("adjacentMobileTab", () => {
  const tabs = MOBILE_TAB_ORDER

  it("moves one tab in either direction", () => {
    expect(adjacentMobileTab(tabs, "chat", 1)).toBe("workspace")
    expect(adjacentMobileTab(tabs, "chat", -1)).toBe("sessions")
  })

  it("does not wrap or navigate from a hidden current tab", () => {
    expect(adjacentMobileTab(tabs, "sessions", -1)).toBeNull()
    expect(adjacentMobileTab(tabs, "workspace", 1)).toBeNull()
  })
})
