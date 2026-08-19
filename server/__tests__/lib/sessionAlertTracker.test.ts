// @vitest-environment node
import { describe, it, expect } from "vitest"
import { SessionAlertTracker, type TrackedSessionSnapshot } from "../../lib/sessionAlertTracker"
import type { SessionStatus } from "../../../shared/session/sessionStatus"

function s(
  sessionId: string,
  status: SessionStatus | null,
  extra: Partial<TrackedSessionSnapshot> = {},
): TrackedSessionSnapshot {
  return { sessionId, status, ...extra }
}

describe("SessionAlertTracker", () => {
  it("announces a turn completion on the working → finished edge", () => {
    const tracker = new SessionAlertTracker()
    expect(tracker.alerts([s("a", "processing")])).toEqual([])
    const alerts = tracker.alerts([s("a", "completed")])
    expect(alerts).toEqual([{ session: s("a", "completed"), reason: "turnComplete" }])
  })

  it("treats idle as a finished turn too", () => {
    const tracker = new SessionAlertTracker()
    tracker.alerts([s("a", "thinking")])
    expect(tracker.alerts([s("a", "idle")])).toHaveLength(1)
  })

  it("never announces sessions it did not watch working (first-sweep seeding)", () => {
    const tracker = new SessionAlertTracker()
    // First sweep: a completed session already sitting there must stay silent.
    expect(tracker.alerts([s("a", "completed"), s("b", "idle")])).toEqual([])
    // And staying completed later must stay silent as well.
    expect(tracker.alerts([s("a", "completed")])).toEqual([])
  })

  it("announces a completion only once until the session works again", () => {
    const tracker = new SessionAlertTracker()
    tracker.alerts([s("a", "tool_use")])
    expect(tracker.alerts([s("a", "completed")])).toHaveLength(1)
    expect(tracker.alerts([s("a", "completed")])).toEqual([])
    // Next turn: working again re-arms the completion alert.
    tracker.alerts([s("a", "processing")])
    expect(tracker.alerts([s("a", "completed")])).toHaveLength(1)
  })

  it("announces entering a permission wait exactly once", () => {
    const tracker = new SessionAlertTracker()
    tracker.alerts([s("a", "tool_use")])
    expect(tracker.alerts([s("a", "deferred")])).toEqual([
      { session: s("a", "deferred"), reason: "permission" },
    ])
    expect(tracker.alerts([s("a", "deferred")])).toEqual([])
    // Resolved and blocked again → a fresh permission alert.
    tracker.alerts([s("a", "tool_use")])
    expect(tracker.alerts([s("a", "deferred")])).toHaveLength(1)
  })

  it("fires permission on the very first sweep — a blocked session is actionable now", () => {
    const tracker = new SessionAlertTracker()
    expect(tracker.alerts([s("a", "deferred")])).toEqual([
      { session: s("a", "deferred"), reason: "permission" },
    ])
  })

  it("does not double-announce a completion while blocked on permission", () => {
    const tracker = new SessionAlertTracker()
    tracker.alerts([s("a", "processing")])
    const alerts = tracker.alerts([s("a", "deferred")])
    expect(alerts.map((a) => a.reason)).toEqual(["permission"])
  })

  it("treats a live Codex turn as working even when the tail looks finished", () => {
    const tracker = new SessionAlertTracker()
    tracker.alerts([s("a", "processing")])
    // Tail lags: transcript says completed but the app-server still holds a turn.
    expect(tracker.alerts([s("a", "completed", { isActiveTurn: true })])).toEqual([])
    expect(tracker.alerts([s("a", "completed")])).toHaveLength(1)
  })

  it("treats awaiting_agents as still working — no alert until the agents finish", () => {
    const tracker = new SessionAlertTracker()
    tracker.alerts([s("a", "processing")])
    // Turn ended but background agents are still running: not the user's move yet.
    expect(tracker.alerts([s("a", "awaiting_agents")])).toEqual([])
    // The agents' notification re-ran the turn, and THAT completion announces.
    expect(tracker.alerts([s("a", "completed")])).toHaveLength(1)
  })

  it("treats an unknown status as still working, never as a completion", () => {
    const tracker = new SessionAlertTracker()
    tracker.alerts([s("a", "processing")])
    expect(tracker.alerts([s("a", null)])).toEqual([])
    expect(tracker.alerts([s("a", "weird_future_status" as SessionStatus)])).toEqual([])
  })

  it("skips teammate sessions — the lead reports for them", () => {
    const tracker = new SessionAlertTracker()
    tracker.alerts([s("a", "processing", { isTeammate: true })])
    expect(tracker.alerts([s("a", "completed", { isTeammate: true })])).toEqual([])
  })

  it("forgets sessions that drop out of the sweep", () => {
    const tracker = new SessionAlertTracker()
    tracker.alerts([s("a", "processing")])
    tracker.alerts([]) // fell out of the window
    // Reappearing as completed must not announce: the edge was never observed.
    expect(tracker.alerts([s("a", "completed")])).toEqual([])
  })
})
