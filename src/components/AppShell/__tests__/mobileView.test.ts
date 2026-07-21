import { describe, expect, it } from "vitest"
import { adjacentMobileTab, visibleMobileTabs } from "../mobileView"

describe("visibleMobileTabs", () => {
  it("hides session-only tabs when no session context exists", () => {
    expect(visibleMobileTabs({
      hasSession: false,
      hasPendingSession: false,
      hasTeam: false,
    })).toEqual(["sessions", "chat"])
  })

  it("keeps stats for pending sessions and teams for team context", () => {
    expect(visibleMobileTabs({
      hasSession: false,
      hasPendingSession: true,
      hasTeam: true,
    })).toEqual(["sessions", "chat", "stats", "teams"])
  })
})

describe("adjacentMobileTab", () => {
  const tabs = ["sessions", "chat", "stats"] as const

  it("moves one tab in either direction", () => {
    expect(adjacentMobileTab(tabs, "chat", 1)).toBe("stats")
    expect(adjacentMobileTab(tabs, "chat", -1)).toBe("sessions")
  })

  it("does not wrap or navigate from a hidden current tab", () => {
    expect(adjacentMobileTab(tabs, "sessions", -1)).toBeNull()
    expect(adjacentMobileTab(tabs, "stats", 1)).toBeNull()
    expect(adjacentMobileTab(tabs, "teams", 1)).toBeNull()
  })
})
