import { describe, expect, it } from "vitest"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import type { MemberStatus } from "@/components/LiveSessions/crew"
import { homeQueue, homeRequestId, homeSessions, landedToday, type HomePending } from "../homeView"

const NOW = Date.parse("2026-10-07T16:00:00")
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

function row(sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return { sessionId, dirName: `-${sessionId}`, fileName: `${sessionId}.jsonl`, projectShortName: sessionId, lastModified: ago(30), lastActivityAt: ago(30), size: 1, ...overrides }
}
const crew = (parentId: string, startedAt: number) => ({ rootId: "lead", parentId, startedAt })

const empty: HomePending = {
  permissionsBySession: new Map(),
  questionsBySession: new Map(),
  elicitationsBySession: new Map(),
  dialogsBySession: new Map(),
  awaitingPlan: new Set(),
}

describe("homeQueue", () => {
  it("puts every request in one queue, the longest waiting first", () => {
    const queue = homeQueue({
      ...empty,
      permissionsBySession: new Map([["a", [{ sessionId: "a", requestId: "p1", toolName: "Bash", summary: "ls", timestamp: NOW - 5_000 }]]]),
      questionsBySession: new Map([["b", [{ sessionId: "b", toolUseId: "q1", askedAt: NOW - 60_000, questions: [] }]]]),
      awaitingPlan: new Set(["c"]),
    }, [row("c", { lastActivityAt: ago(10) }), row("d", { agentStatus: "deferred", lastActivityAt: ago(20) })])

    expect(queue.map((request) => [request.kind, homeRequestId(request)])).toEqual([
      ["deferred", "deferred:d"],
      ["plan", "plan:c"],
      ["question", "q1"],
      ["permission", "p1"],
    ])
  })

  it("leaves out requests the user cannot answer", () => {
    const pending = { ...empty, awaitingPlan: new Set(["mine", "theirs"]) }
    expect(homeQueue(pending, [], (id) => id === "mine").map((request) => request.sessionId)).toEqual(["mine"])
  })
})

describe("homeSessions", () => {
  const statusOf = (member: ActiveSessionInfo): MemberStatus => ({ state: member.agentStatus === "tool_use" ? "working" : "done" })

  it("lists the sessions the user started with their crews, newest crew activity first", () => {
    const pr = { url: "u", number: 252, repo: "o/r", title: "Ops tooling", isDraft: false, toolCallId: "", timestamp: ago(40) }
    const sessions = [
      row("lead", { lastActivityAt: ago(120) }),
      row("lane", { crew: crew("lead", 1), agentStatus: "tool_use", lastActivityAt: ago(1), pullRequests: [pr] }),
      row("solo", { lastActivityAt: ago(10) }),
      row("old", { lastActivityAt: ago(3 * 24 * 60) }),
    ]
    const home = homeSessions(sessions, statusOf, NOW)
    expect(home.map((entry) => entry.session.sessionId)).toEqual(["lead", "solo", "old"])
    expect(home[0]).toMatchObject({ cells: ["working"], counts: { size: 1, working: 1 }, activityAt: ago(1), landed: { number: 252 } })
  })
})

describe("landedToday", () => {
  it("collects today's pull requests, finished members and starts, newest first", () => {
    const today = Date.parse("2026-10-07T09:00:00")
    const sessions = [
      row("lead"),
      row("a", { crew: crew("lead", today), lastActivityAt: ago(5) }),
      row("b", { crew: crew("lead", today + 20_000), agentStatus: "tool_use", lastActivityAt: ago(2), pullRequests: [{ url: "u", number: 7, repo: "o/r", title: "Fix", isDraft: false, toolCallId: "", timestamp: ago(3) }] }),
      row("yesterday", { crew: crew("lead", today - 86_400_000), lastActivityAt: ago(24 * 60 + 60) }),
    ]
    const statusOf = (member: ActiveSessionInfo): MemberStatus => ({ state: member.agentStatus === "tool_use" ? "working" : "done" })
    const landed = landedToday(sessions, statusOf, NOW)
    expect(landed.map((event) => event.kind === "started" ? ["started", event.sessions.map((s) => s.sessionId)] : [event.kind, event.session.sessionId]))
      .toEqual([["pr", "b"], ["finished", "a"], ["started", ["a", "b"]]])
  })
})
