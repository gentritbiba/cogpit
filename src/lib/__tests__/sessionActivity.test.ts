import { describe, expect, it } from "vitest"
import type { ActiveSessionInfo, RunningProcess } from "@/components/LiveSessions/types"
import { hasUnfinishedWork, isRecentlyActive, isSessionActive } from "../sessionActivity"

const NOW = Date.parse("2026-08-01T12:00:00Z")
const FRESH = "2026-08-01T11:59:00Z" // 1m ago
const STALE = "2026-08-01T11:30:00Z" // 30m ago

function session(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "proj",
    projectShortName: "proj",
    fileName: "s.jsonl",
    sessionId: "s",
    lastModified: FRESH,
    size: 1,
    ...overrides,
  }
}

const NO_PROCS = new Map<string, RunningProcess>()

function procsFor(sessionId: string): Map<string, RunningProcess> {
  return new Map([[sessionId, {
    pid: 1, memMB: 1, cpu: 0, sessionId, tty: "?", args: "claude", startTime: "",
  }]])
}

describe("isRecentlyActive", () => {
  it("prefers lastActivityAt over lastModified", () => {
    expect(isRecentlyActive(session({ lastActivityAt: STALE, lastModified: FRESH }), NOW)).toBe(false)
    expect(isRecentlyActive(session({ lastActivityAt: FRESH, lastModified: STALE }), NOW)).toBe(true)
  })

  it("rejects an unparseable timestamp instead of guessing", () => {
    expect(isRecentlyActive(session({ lastModified: "not-a-date" }), NOW)).toBe(false)
  })
})

describe("isSessionActive", () => {
  it("trusts a mapped process even when the file is stale", () => {
    const s = session({ agentStatus: "tool_use", lastModified: STALE })
    expect(isSessionActive(s, procsFor("s"), NOW)).toBe(true)
  })

  it("accepts a recent working status with no process mapped", () => {
    // Sessions owned by another Cogpit never map to a PID.
    expect(isSessionActive(session({ agentStatus: "tool_use" }), NO_PROCS, NOW)).toBe(true)
  })

  it("rejects a stale working status", () => {
    const s = session({ agentStatus: "tool_use", lastModified: STALE })
    expect(isSessionActive(s, NO_PROCS, NOW)).toBe(false)
  })

  it("rejects a completed session however recent", () => {
    expect(isSessionActive(session({ agentStatus: "completed" }), NO_PROCS, NOW)).toBe(false)
  })

  it("rejects a session with no status at all", () => {
    expect(isSessionActive(session(), NO_PROCS, NOW)).toBe(false)
  })
})

describe("hasUnfinishedWork", () => {
  it("goes false for a stale session the UI already calls finished", () => {
    // deriveSessionStatus leaves "tool_use" on anything killed mid-tool, and
    // /api/active-sessions keeps returning it. Gating on status alone would let
    // one long-dead session poll `ps` forever. Recovery when this goes false is
    // the provider's focus listener, not a timer.
    const s = session({ agentStatus: "tool_use", lastModified: STALE })
    expect(isSessionActive(s, NO_PROCS, NOW)).toBe(false)
    expect(hasUnfinishedWork([s], NO_PROCS, NOW)).toBe(false)
  })

  it("stays true while a session is genuinely working", () => {
    const s = session({ agentStatus: "tool_use", lastModified: FRESH })
    expect(hasUnfinishedWork([s], NO_PROCS, NOW)).toBe(true)
  })

  it("is false once every session has completed", () => {
    expect(hasUnfinishedWork([
      session({ sessionId: "a", agentStatus: "completed" }),
      session({ sessionId: "b", agentStatus: "completed" }),
    ], NO_PROCS)).toBe(false)
  })

  it("is false for sessions with no status", () => {
    expect(hasUnfinishedWork([session()], NO_PROCS)).toBe(false)
  })

  it("ignores a lingering process on a completed session", () => {
    // The PID outlives the work by a moment. Treating it as unfinished would
    // keep the poll running forever after the last agent stopped.
    const s = session({ agentStatus: "completed" })
    expect(hasUnfinishedWork([s], procsFor("s"))).toBe(false)
  })

  it("is true for a live session that has not reported a status yet", () => {
    const s = session({ isActive: true })
    expect(hasUnfinishedWork([s], NO_PROCS)).toBe(true)
  })

  it("is false for an empty inventory", () => {
    expect(hasUnfinishedWork([], NO_PROCS)).toBe(false)
  })
})
