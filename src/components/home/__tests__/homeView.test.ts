import { describe, expect, it } from "vitest"
import type { ActiveSessionInfo } from "@/components/LiveSessions/types"
import type { MemberStatus } from "@/components/LiveSessions/crew"
import { homeQueue, homeRequestId, homeSessionRows, homeSessions, recentHomeProjects, searchHomeSessions, type HomePending } from "../homeView"

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
      row("old", { lastActivityAt: ago(30 * 24 * 60) }),
    ]
    const home = homeSessions(homeSessionRows(sessions, statusOf), NOW)
    expect(home.map((entry) => entry.session.sessionId)).toEqual(["lead", "solo", "old"])
    expect(home[0]).toMatchObject({ state: "done", crew: [{ member: { sessionId: "lane" }, state: "working" }], counts: { size: 1, working: 1 }, activityAt: ago(1), landed: { number: 252 } })
  })

  it("orders a crew by who needs the user, then who is working, newest first within each", () => {
    const status = (member: ActiveSessionInfo): MemberStatus => ({
      state: member.agentStatus === "deferred" ? "needs-you" : member.agentStatus === "tool_use" ? "working" : "done",
    })
    const [entry] = homeSessionRows([
      row("lead"),
      row("old-done", { crew: crew("lead", 1), lastActivityAt: ago(50) }),
      row("new-done", { crew: crew("lead", 2), lastActivityAt: ago(5) }),
      row("worker", { crew: crew("lead", 3), agentStatus: "tool_use", lastActivityAt: ago(40) }),
      row("asker", { crew: crew("lead", 4), agentStatus: "deferred", lastActivityAt: ago(60) }),
    ], status)
    expect(entry!.crew.map(({ member }) => member.sessionId)).toEqual(["asker", "worker", "new-done", "old-done"])
  })

  it("offers the newest sessions' projects once each, newest first", () => {
    const rows = homeSessionRows([
      row("a", { dirName: "-x", cwd: "/x", lastActivityAt: ago(1) }),
      row("b", { dirName: "-y", cwd: "/y", lastActivityAt: ago(2) }),
      row("c", { dirName: "-x", cwd: "/x", lastActivityAt: ago(3) }),
      row("d", { dirName: "-unknown-folder", lastActivityAt: ago(4) }),
      row("e", { dirName: "-x-by-another-agent", cwd: "/x", lastActivityAt: ago(5) }),
      row("f", { dirName: "-z", cwd: "/z", lastActivityAt: ago(6) }),
    ], statusOf)
    const projectOf = (session: ActiveSessionInfo) => ({ dirName: session.dirName, cwd: session.cwd })
    expect(recentHomeProjects(rows, projectOf).map((project) => project.dirName)).toEqual(["-x", "-y", "-z"])
    expect(recentHomeProjects(rows, projectOf, 2).map((project) => project.dirName)).toEqual(["-x", "-y"])
  })

  it("shows the last week, never fewer than three, and at most a page", () => {
    const week = Array.from({ length: 40 }, (_, index) => row(`s${index}`, { lastActivityAt: ago(index * 60) }))
    expect(homeSessions(homeSessionRows(week, statusOf), NOW)).toHaveLength(30)
    const sparse = [row("a", { lastActivityAt: ago(8 * 24 * 60) }), row("b", { lastActivityAt: ago(9 * 24 * 60) }), row("c", { lastActivityAt: ago(10 * 24 * 60) }), row("d", { lastActivityAt: ago(11 * 24 * 60) })]
    expect(homeSessions(homeSessionRows(sparse, statusOf), NOW).map((entry) => entry.session.sessionId)).toEqual(["a", "b", "c"])
  })

  it("searches every session by every word, keeping the newest first", () => {
    const rows = homeSessionRows([
      row("fresh", { lastActivityAt: ago(5), lastUserMessage: "fix the login form" }),
      row("stale", { lastActivityAt: ago(60 * 24 * 60), gitBranch: "login-redesign" }),
      row("other", { lastActivityAt: ago(10), lastUserMessage: "release notes" }),
    ], statusOf)
    const textOf = (entry: ReturnType<typeof homeSessionRows>[number]) => [entry.session.sessionId, entry.session.lastUserMessage, entry.session.gitBranch]
    expect(searchHomeSessions(rows, "login", textOf).map((entry) => entry.session.sessionId)).toEqual(["fresh", "stale"])
    expect(searchHomeSessions(rows, "LOGIN redesign", textOf).map((entry) => entry.session.sessionId)).toEqual(["stale"])
    expect(searchHomeSessions(rows, "   ", textOf)).toEqual([])
  })
})
