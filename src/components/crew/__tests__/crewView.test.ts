import { describe, expect, it } from "vitest"
import type { CrewMember, SessionCrew } from "../../../../shared/contracts/crew"
import {
  crewMemberName,
  crewRequests,
  crewTally,
  crewTree,
  memberActivity,
  memberCellState,
} from "../crewView"

function member(sessionId: string, overrides: Partial<CrewMember> = {}): CrewMember {
  return {
    sessionId,
    parentId: "coordinator",
    startedAt: 1,
    device: null,
    address: { dirName: `-${sessionId}`, fileName: `${sessionId}.jsonl` },
    outcome: "completed",
    waiting: [],
    cwd: `/work/${sessionId}`,
    ...overrides,
  }
}

const permission = { kind: "permission" as const, requestId: "p1", toolName: "Bash", summary: "gh api repos/x/rulesets", availableDecisions: ["allow" as const, "deny" as const] }
const question = { kind: "question" as const, requestId: "q1", questions: [{ question: "Which hostname?", multiSelect: false, options: ["a", "b"] }] }

const crew: SessionCrew = {
  sessionId: "coordinator",
  rootId: "coordinator",
  members: [
    member("coordinator", { parentId: null, startedAt: null, customTitle: "Wave 3 coordinator", cwd: "/work/ops" }),
    member("rooftop", { startedAt: 10, outcome: "needs_input", waiting: [permission], customTitle: "w3-rooftop", lastActivityAt: "2026-10-07T10:00:00Z" }),
    member("security", { startedAt: 20, outcome: "needs_input", waiting: [question], lastActivityAt: "2026-10-07T12:00:00Z" }),
    member("reviewer", { parentId: "rooftop", startedAt: 30, cwd: "/work/rooftop", firstUserMessage: "Review packet r2" }),
    member("storefront", { startedAt: 15, outcome: "running", status: "tool_use", toolName: "Bash" }),
    member("theories", { startedAt: 40, result: { taskId: "t", state: "completed", acknowledged: false } }),
    member("broken", { startedAt: 50, outcome: "error", error: "Prompt is too long" }),
    member("remote", { startedAt: 60, outcome: "unreachable", device: { id: "d", name: "agentbox" } }),
  ],
}

describe("crewView", () => {
  it("lays the crew out as a tree under its root, each level in start order", () => {
    expect(crewTree(crew).map((row) => [row.member.sessionId, row.depth, row.children])).toEqual([
      ["rooftop", 0, 1],
      ["reviewer", 1, 0],
      ["storefront", 0, 0],
      ["security", 0, 0],
      ["theories", 0, 0],
      ["broken", 0, 0],
      ["remote", 0, 0],
    ])
  })

  it("says what each cell of the formation strip shows", () => {
    const states = Object.fromEntries(crew.members.map((value) => [value.sessionId, memberCellState(value)]))
    expect(states).toMatchObject({
      rooftop: "needs-you", storefront: "working", reviewer: "done", broken: "failed", remote: "unreachable",
    })
  })

  it("queues every request the crew is blocked on, the longest waiting first", () => {
    expect(crewRequests(crew).map(({ member: value, pending }) => [value.sessionId, pending.requestId])).toEqual([
      ["rooftop", "p1"],
      ["security", "q1"],
    ])
  })

  it("counts the crew, without its root, and the results its sessions have not read", () => {
    expect(crewTally(crew)).toEqual({ size: 7, working: 1, needsYou: 2, done: 2, failed: 1, unreachable: 1, unreadResults: 1 })
  })

  it("names members the way the session list does", () => {
    const byId = new Map(crew.members.map((value) => [value.sessionId, value]))
    expect(crewMemberName(byId.get("coordinator")!, byId, {})).toBe("Wave 3 coordinator")
    expect(crewMemberName(byId.get("rooftop")!, byId, {})).toBe("w3-rooftop")
    expect(crewMemberName(byId.get("storefront")!, byId, {})).toBe("storefront")
    expect(crewMemberName(byId.get("reviewer")!, byId, {})).toBe("Review packet r2")
    expect(crewMemberName(byId.get("rooftop")!, byId, { rooftop: "mine" })).toBe("mine")
  })

  it("describes what a member is doing in a line", () => {
    const byId = new Map(crew.members.map((value) => [value.sessionId, value]))
    expect(memberActivity(byId.get("rooftop")!)).toBe("Waiting on a permission · Bash")
    expect(memberActivity(byId.get("security")!)).toBe("Asked a question")
    expect(memberActivity(byId.get("storefront")!)).toBe("Bash")
    expect(memberActivity(byId.get("theories")!)).toBe("Finished · result unread")
    expect(memberActivity(byId.get("broken")!)).toBe("Failed · Prompt is too long")
    expect(memberActivity(byId.get("remote")!)).toBe("agentbox is not answering")
  })
})
