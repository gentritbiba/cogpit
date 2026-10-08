import { describe, expect, it } from "vitest"
import {
  countCrew,
  crewActivityAt,
  directReports,
  foldCrewRows,
  memberName,
  memberStatus,
  NO_PENDING_INPUT,
} from "../crew"
import type { ActiveSessionInfo, RunningProcess } from "../types"

const NOW = Date.parse("2026-10-07T16:00:00Z")
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

function row(sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: `-work-${sessionId}`,
    projectShortName: sessionId,
    fileName: `${sessionId}.jsonl`,
    sessionId,
    cwd: `/work/${sessionId}`,
    lastModified: minutesAgo(30),
    lastActivityAt: minutesAgo(30),
    size: 1,
    ...overrides,
  }
}

const member = (sessionId: string, parentId: string, startedAt: number, overrides: Partial<ActiveSessionInfo> = {}) =>
  row(sessionId, { crew: { rootId: "coordinator", parentId, startedAt }, ...overrides })

const ids = (rows: readonly ActiveSessionInfo[]) => rows.map((value) => value.sessionId)

function procs(...sessionIds: string[]): Map<string, RunningProcess> {
  return new Map(sessionIds.map((sessionId) => [sessionId, {
    pid: 1, memMB: 1, cpu: 0, sessionId, tty: "", startTime: "",
  }]))
}

describe("foldCrewRows", () => {
  it("places every level of a crew under its root, in the order they were started", () => {
    const rows = [
      row("coordinator"),
      member("reviewer", "lane-a", 3),
      member("lane-b", "coordinator", 2),
      row("other"),
      member("lane-a", "coordinator", 1),
    ]
    const { topLevel, crewOf } = foldCrewRows(rows)
    expect(ids(topLevel)).toEqual(["coordinator", "other"])
    expect(ids(crewOf.get("coordinator")!)).toEqual(["lane-a", "lane-b", "reviewer"])
  })

  it("keeps a member on its own when no ancestor is listed", () => {
    const { topLevel, crewOf } = foldCrewRows([member("lane-a", "coordinator", 1)])
    expect(ids(topLevel)).toEqual(["lane-a"])
    expect(crewOf.size).toBe(0)
  })

  it("never places a member under an archived session, as the list does not", () => {
    const rows = [
      row("coordinator", { archived: true }),
      member("lane-a", "coordinator", 1),
      member("reviewer", "lane-a", 2),
    ]
    const { topLevel, crewOf } = foldCrewRows(rows)
    expect(ids(topLevel)).toEqual(["coordinator", "lane-a"])
    expect(ids(crewOf.get("lane-a")!)).toEqual(["reviewer"])
  })

  it("reaches the root across a parent the list does not carry", () => {
    const rows = [row("coordinator"), member("reviewer", "lane-a", 2)]
    expect(ids(foldCrewRows(rows).crewOf.get("coordinator")!)).toEqual(["reviewer"])
  })
})

describe("memberStatus", () => {
  it("needs someone when blocked on any request or a deferred permission", () => {
    const pending = { ...NO_PENDING_INPUT, awaitingQuestion: new Set(["asks"]) }
    expect(memberStatus(row("asks"), new Map(), pending)).toEqual({ state: "needs-you", need: "question" })
    expect(memberStatus(row("deferred", { agentStatus: "deferred" }), new Map(), NO_PENDING_INPUT))
      .toEqual({ state: "needs-you", need: "deferred" })
  })

  it("works while live and mid-flight, and is done once its turn has ended", () => {
    const live = procs("busy", "idle")
    expect(memberStatus(row("busy", { agentStatus: "tool_use" }), live, NO_PENDING_INPUT)).toEqual({ state: "working" })
    // An idle member finished its turn: it waits for its lead, not for the user.
    expect(memberStatus(row("idle", { agentStatus: "idle" }), live, NO_PENDING_INPUT)).toEqual({ state: "done" })
    expect(memberStatus(row("gone", { agentStatus: "completed" }), new Map(), NO_PENDING_INPUT)).toEqual({ state: "done" })
  })
})

describe("countCrew", () => {
  it("counts each state and finds who has waited longest", () => {
    const members = [
      row("a", { lastActivityAt: minutesAgo(5) }),
      row("b", { lastActivityAt: minutesAgo(42) }),
      row("c"),
      row("d"),
    ]
    const states = { a: "needs-you", b: "needs-you", c: "working", d: "done" } as const
    expect(countCrew(members, (value) => ({ state: states[value.sessionId as keyof typeof states] }))).toEqual({
      size: 4, needsYou: 2, working: 1, done: 1, longestWaitSince: minutesAgo(42),
    })
  })
})

describe("crewActivityAt", () => {
  it("is the latest activity of the session or any member", () => {
    expect(crewActivityAt(row("root", { lastActivityAt: minutesAgo(60) }), [
      row("a", { lastActivityAt: minutesAgo(3) }),
      row("b", { lastActivityAt: minutesAgo(10) }),
    ])).toBe(minutesAgo(3))
    expect(crewActivityAt(row("root", { lastActivityAt: minutesAgo(1) }), [])).toBe(minutesAgo(1))
  })
})

describe("memberName", () => {
  const coordinator = row("coordinator", { cwd: "/work/hcms-pr/performance-experiments" })

  it("prefers the user's name, then the name it was started with, then its own title", () => {
    const lane = member("lane", "coordinator", 1, { cwd: "/work/hcms-pr/w3-rooftop", customTitle: "rooftop lane" })
    expect(memberName(lane, { customName: "mine", parent: coordinator })).toBe("mine")
    expect(memberName({ ...lane, crew: { ...lane.crew!, name: "w3-rooftop" } }, { parent: coordinator })).toBe("w3-rooftop")
    expect(memberName(lane, { parent: coordinator })).toBe("rooftop lane")
  })

  it("names a member by the folder it works in when that differs from its parent's", () => {
    const lane = member("lane", "coordinator", 1, { cwd: "/work/hcms-pr/w3-rooftop", firstUserMessage: "Read the brief" })
    expect(memberName(lane, { parent: coordinator })).toBe("w3-rooftop")
    const reviewer = member("reviewer", "lane", 2, { cwd: "/work/hcms-pr/w3-rooftop", firstUserMessage: "Review packet r2" })
    expect(memberName(reviewer, { parent: lane })).toBe("Review packet r2")
  })
})

describe("memberName from a brief", () => {
  it("uses the brief's first line, without heading marks, for a member with nothing else to go by", () => {
    const lane = member("lane", "coordinator", 1, { cwd: "/work/w3-rooftop" })
    const reviewer = member("reviewer", "lane", 2, {
      cwd: "/work/w3-rooftop",
      firstUserMessage: "# Reviewer instructions\n\nYou are an independent Codex reviewer.",
      lastUserMessage: "Follow-up review r4",
    })
    expect(memberName(reviewer, { parent: lane })).toBe("Reviewer instructions")
  })
})

describe("directReports", () => {
  it("counts the members a member started itself", () => {
    const members = [member("lane", "coordinator", 1), member("r1", "lane", 2), member("r2", "lane", 3)]
    expect(directReports("lane", members)).toBe(2)
    expect(directReports("r1", members)).toBe(0)
  })
})
