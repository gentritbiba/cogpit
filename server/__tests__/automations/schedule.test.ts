// @vitest-environment node
import { describe, expect, it } from "vitest"
import { nextDue, scheduleProblem, zonedInstant } from "../../automations/schedule"
import { WEEKDAYS, type AutomationSchedule, type Weekday } from "../../../shared/contracts/automations"

const iso = (instant: number) => new Date(instant).toISOString()
const daily = (time: string, timeZone = "America/New_York", days: Weekday[] = [...WEEKDAYS]): AutomationSchedule => ({ kind: "daily", time, days, timeZone })

describe("automation schedules", () => {
  it("counts intervals from when the task started, skipping slots already past", () => {
    const anchor = Date.parse("2026-10-29T00:00:00Z")
    const every = { kind: "interval", everyMinutes: 30 } as const
    expect(iso(nextDue(every, anchor, anchor))).toBe("2026-10-29T00:30:00.000Z")
    expect(iso(nextDue(every, anchor + 31 * 60_000, anchor))).toBe("2026-10-29T01:00:00.000Z")
    expect(iso(nextDue(every, anchor + 3 * 60 * 60_000 + 1, anchor))).toBe("2026-10-29T03:30:00.000Z")
  })

  it("runs at wall-clock time in its own zone, only on the chosen weekdays", () => {
    // Thursday 2026-10-29 10:00 New York (EDT, UTC-4).
    const now = Date.parse("2026-10-29T14:00:00Z")
    expect(iso(nextDue(daily("09:30"), now, 0))).toBe("2026-10-30T13:30:00.000Z")
    expect(iso(nextDue(daily("11:00"), now, 0))).toBe("2026-10-29T15:00:00.000Z")
    expect(iso(nextDue(daily("09:30", "America/New_York", ["mon"]), now, 0))).toBe("2026-11-02T14:30:00.000Z")
    expect(iso(nextDue(daily("09:30", "Asia/Tokyo"), now, 0))).toBe("2026-10-30T00:30:00.000Z")
  })

  it("follows daylight saving: the fall-back day runs once, at the first 01:30", () => {
    // 2026-11-01: New York falls back at 02:00 EDT to 01:00 EST, so 01:30 happens twice.
    const before = Date.parse("2026-11-01T04:00:00Z")
    const due = nextDue(daily("01:30"), before, 0)
    expect(iso(due)).toBe("2026-11-01T05:30:00.000Z")
    expect(iso(nextDue(daily("01:30"), due, 0))).toBe("2026-11-02T06:30:00.000Z")
    // Across the change the day's 09:00 moves from 13:00Z to 14:00Z.
    expect(iso(nextDue(daily("09:00"), Date.parse("2026-10-31T14:00:00Z"), 0))).toBe("2026-11-01T14:00:00.000Z")
  })

  it("follows daylight saving: a time the spring-forward skips runs right after the gap", () => {
    // 2027-03-14: New York springs forward from 02:00 EST to 03:00 EDT; 02:30 never happens.
    expect(iso(zonedInstant("America/New_York", { year: 2027, month: 3, day: 14, hour: 2, minute: 30 }))).toBe("2027-03-14T07:00:00.000Z")
    expect(iso(nextDue(daily("02:30"), Date.parse("2027-03-14T05:00:00Z"), 0))).toBe("2027-03-14T07:00:00.000Z")
    expect(iso(nextDue(daily("02:30"), Date.parse("2027-03-14T07:00:00Z"), 0))).toBe("2027-03-15T06:30:00.000Z")
  })

  it("rejects schedules it cannot run", () => {
    expect(scheduleProblem({ kind: "interval", everyMinutes: 1 })).toMatch(/5 minutes/)
    expect(scheduleProblem(daily("25:00"))).toMatch(/time like/)
    expect(scheduleProblem(daily("09:00", "Mars/Olympus"))).toMatch(/time zone/)
    expect(scheduleProblem({ kind: "daily", time: "09:00", days: [], timeZone: "UTC" })).toMatch(/weekday/)
    expect(scheduleProblem(daily("09:00"))).toBeNull()
  })
})
