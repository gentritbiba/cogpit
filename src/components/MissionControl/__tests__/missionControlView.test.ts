import { describe, expect, it } from "vitest"
import type { ActiveSessionInfo, RunningProcess } from "@/components/LiveSessions/types"
import type {
  MissionControlPermission,
  MissionControlSummary,
} from "../../../../shared/contracts/missionControl"
import {
  buildMissionCards,
  countMissionCards,
  filterMissionCards,
  formatElapsed,
  formatTokens,
  contextBarColor,
  isFinished,
  needsYou,
} from "../missionControlView"

const NOW = Date.parse("2026-08-01T12:00:00Z")
const FRESH = "2026-08-01T11:59:30Z" // 30s ago
const STALE = "2026-08-01T11:50:00Z" // 10m ago

function session(overrides: Partial<ActiveSessionInfo> & { sessionId: string }): ActiveSessionInfo {
  return {
    dirName: "proj",
    projectShortName: "proj",
    fileName: `${overrides.sessionId}.jsonl`,
    lastModified: FRESH,
    size: 10,
    ...overrides,
  }
}

function permission(sessionId: string, requestId = "req-1"): MissionControlPermission {
  return {
    sessionId,
    requestId,
    toolName: "Bash",
    summary: "rm -rf dist/",
    timestamp: NOW,
  }
}

const NO_PROCS = new Map<string, RunningProcess>()
const NO_SUMMARIES = new Map<string, MissionControlSummary>()

function build(
  sessions: ActiveSessionInfo[],
  permissions: MissionControlPermission[] = [],
  extra: Partial<Parameters<typeof buildMissionCards>[0]> = {},
) {
  const permissionsBySession = new Map<string, MissionControlPermission[]>()
  for (const p of permissions) {
    const list = permissionsBySession.get(p.sessionId)
    if (list) list.push(p)
    else permissionsBySession.set(p.sessionId, [p])
  }
  return buildMissionCards({
    sessions,
    procBySession: NO_PROCS,
    summaries: NO_SUMMARIES,
    permissionsBySession,
    newlyCompleted: new Set(),
    now: NOW,
    ...extra,
  })
}

describe("buildMissionCards — state resolution", () => {
  it("treats a recent working status as running even with no process mapped", () => {
    // A session started outside this Cogpit never maps to a PID. Requiring one
    // would report every remote agent as finished.
    const cards = build([session({ sessionId: "a", agentStatus: "tool_use" })])
    expect(cards[0].state).toBe("running")
  })

  it("decays an abandoned mid-tool-call session to done once it goes stale", () => {
    const cards = build([
      session({ sessionId: "a", agentStatus: "tool_use", lastModified: STALE }),
    ])
    expect(cards[0].state).toBe("done")
  })

  it("keeps a stale session running while a process is still mapped to it", () => {
    const procs = new Map<string, RunningProcess>([
      ["a", { pid: 1, memMB: 10, cpu: 1, sessionId: "a", tty: "?", args: "claude", startTime: "" }],
    ])
    const cards = buildMissionCards({
      sessions: [session({ sessionId: "a", agentStatus: "tool_use", lastModified: STALE })],
      procBySession: procs,
      summaries: NO_SUMMARIES,
      permissionsBySession: new Map(),
      newlyCompleted: new Set(),
      now: NOW,
    })
    expect(cards[0].state).toBe("running")
  })

  it("reports a pending permission as awaiting_approval regardless of status", () => {
    const cards = build(
      [session({ sessionId: "a", agentStatus: "tool_use" })],
      [permission("a")],
    )
    expect(cards[0].state).toBe("awaiting_approval")
    expect(cards[0].permissions).toHaveLength(1)
  })

  it("still surfaces a permission on an otherwise stale session", () => {
    // The agent is blocked, so its file stopped changing. Staleness must not
    // hide the very thing the user has to answer.
    const cards = build(
      [session({ sessionId: "a", agentStatus: "tool_use", lastModified: STALE })],
      [permission("a")],
    )
    expect(cards[0].state).toBe("awaiting_approval")
  })

  it("maps a deferred hook to awaiting_answer, not awaiting_approval", () => {
    // Deferred permissions are resolved by resuming the session, so the card
    // must not offer inline Allow/Deny for them.
    const cards = build([session({ sessionId: "a", agentStatus: "deferred" })])
    expect(cards[0].state).toBe("awaiting_answer")
  })

  it("maps an idle live session to awaiting_answer", () => {
    const cards = build([session({ sessionId: "a", agentStatus: "idle" })])
    expect(cards[0].state).toBe("awaiting_answer")
  })

  it("maps an early stop to failed", () => {
    const cards = build([
      session({ sessionId: "a", agentStatus: "completed", agentTerminalReason: "max_turns" }),
    ])
    expect(cards[0].state).toBe("failed")
  })

  it("maps a clean completion to done", () => {
    const cards = build([session({ sessionId: "a", agentStatus: "completed" })])
    expect(cards[0].state).toBe("done")
  })
})

describe("buildMissionCards — ordering and inclusion", () => {
  it("sorts blocked sessions ahead of running, and running ahead of finished", () => {
    const cards = build(
      [
        session({ sessionId: "done", agentStatus: "completed" }),
        session({ sessionId: "run", agentStatus: "thinking" }),
        session({ sessionId: "perm", agentStatus: "tool_use" }),
        session({ sessionId: "idle", agentStatus: "idle" }),
      ],
      [permission("perm")],
    )
    expect(cards.map((c) => c.session.sessionId)).toEqual(["perm", "idle", "run", "done"])
  })

  it("hides teammate sessions but keeps a teammate that is blocked on the user", () => {
    const cards = build(
      [
        session({ sessionId: "mate", agentStatus: "thinking", teamName: "t", agentName: "m" }),
        session({ sessionId: "blocked", agentStatus: "thinking", teamName: "t", agentName: "m2" }),
      ],
      [permission("blocked")],
    )
    expect(cards.map((c) => c.session.sessionId)).toEqual(["blocked"])
  })

  it("caps finished sessions so the grid stays a picture of current work", () => {
    const finished = Array.from({ length: 10 }, (_, i) =>
      session({ sessionId: `f${i}`, agentStatus: "completed" }))
    const cards = build(finished, [], { finishedLimit: 3 })
    expect(cards).toHaveLength(3)
  })

  it("keeps a session that finished while the user was watching, past the cap", () => {
    const finished = Array.from({ length: 5 }, (_, i) =>
      session({ sessionId: `f${i}`, agentStatus: "completed" }))
    const cards = build(finished, [], {
      finishedLimit: 2,
      newlyCompleted: new Set(["f4"]),
    })
    expect(cards.map((c) => c.session.sessionId)).toContain("f4")
  })

  it("never drops a running session to honour the finished cap", () => {
    const sessions = [
      session({ sessionId: "run", agentStatus: "tool_use" }),
      ...Array.from({ length: 8 }, (_, i) =>
        session({ sessionId: `f${i}`, agentStatus: "completed" })),
    ]
    const cards = build(sessions, [], { finishedLimit: 1 })
    expect(cards.map((c) => c.session.sessionId)).toContain("run")
    expect(cards).toHaveLength(2)
  })
})

describe("filterMissionCards / countMissionCards", () => {
  const cards = build(
    [
      session({ sessionId: "perm", agentStatus: "tool_use" }),
      session({ sessionId: "run", agentStatus: "thinking" }),
      session({ sessionId: "done", agentStatus: "completed" }),
      session({ sessionId: "fail", agentStatus: "completed", agentTerminalReason: "max_turns" }),
    ],
    [permission("perm")],
  )

  it("counts each bucket", () => {
    expect(countMissionCards(cards)).toEqual({
      total: 4, running: 1, needsYou: 1, finished: 2, failed: 1,
    })
  })

  it("filters to running only", () => {
    expect(filterMissionCards(cards, "running").map((c) => c.session.sessionId)).toEqual(["run"])
  })

  it("filters to sessions blocked on the user", () => {
    expect(filterMissionCards(cards, "needs-you").map((c) => c.session.sessionId)).toEqual(["perm"])
  })

  it("filters to finished, including failures", () => {
    expect(filterMissionCards(cards, "finished").map((c) => c.session.sessionId).sort())
      .toEqual(["done", "fail"])
  })

  it("returns everything for all", () => {
    expect(filterMissionCards(cards, "all")).toHaveLength(4)
  })
})

describe("state predicates", () => {
  it("classifies which states need the user", () => {
    expect(needsYou("awaiting_approval")).toBe(true)
    expect(needsYou("awaiting_answer")).toBe(true)
    expect(needsYou("running")).toBe(false)
    expect(needsYou("done")).toBe(false)
  })

  it("classifies which states are finished", () => {
    expect(isFinished("done")).toBe(true)
    expect(isFinished("failed")).toBe(true)
    expect(isFinished("running")).toBe(false)
  })
})

describe("formatters", () => {
  it("formats elapsed spans", () => {
    expect(formatElapsed(0)).toBe("—")
    expect(formatElapsed(45_000)).toBe("45s")
    expect(formatElapsed(192_000)).toBe("3m 12s")
    expect(formatElapsed(3_840_000)).toBe("1h 04m")
  })

  it("formats token totals with separators", () => {
    expect(formatTokens(148_092)).toBe("148,092")
    expect(formatTokens(0)).toBe("0")
  })


  it("escalates context bar colour with pressure", () => {
    expect(contextBarColor(31)).toBe("bg-green-500")
    expect(contextBarColor(71)).toBe("bg-amber-500")
    expect(contextBarColor(95)).toBe("bg-red-500")
  })
})
