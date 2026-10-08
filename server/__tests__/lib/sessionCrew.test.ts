// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import type { DelegatedTask } from "../../../shared/contracts/orchestration"
import { readSessionCrew, type CrewSources } from "../../lib/sessionCrew"
import type { CrewLink } from "../../lib/sessionOrigins"
import type { SessionState } from "../../lib/sessionWait"

const links = (entries: Array<[string, string, number, string?]>): ReadonlyMap<string, CrewLink> =>
  new Map(entries.map(([child, parent, createdAt, name]) => [child, { parentSessionId: parent, createdAt, ...(name ? { name } : {}) }]))

const state = (sessionId: string, overrides: Partial<SessionState> = {}): SessionState => ({
  sessionId, outcome: "completed", live: false, running: false, waiting: [], ...overrides,
})

function task(childSessionId: string, overrides: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: `task-${childSessionId}`, parentSessionId: "coordinator", childSessionId, sourceId: childSessionId,
    state: "completed", createdAt: 1, updatedAt: 2, ...overrides,
  }
}

function sources(overrides: Partial<CrewSources> = {}): CrewSources {
  return {
    parents: links([
      ["lane-b", "coordinator", 20],
      ["lane-a", "coordinator", 10, "w3-lane-a"],
      ["reviewer", "lane-a", 30],
      ["elsewhere", "other-root", 5],
    ]),
    canView: async () => true,
    describe: async (sessionId) => ({
      host: sessionId === "lane-b" ? { remote: true, id: "dev_1", name: "agentbox" } : { remote: false, id: "local", name: "This Mac" },
      state: state(sessionId, sessionId === "reviewer"
        ? { outcome: "needs_input", waiting: [{ kind: "permission", requestId: "r1", toolName: "Bash", summary: "gh api", availableDecisions: ["allow", "deny"] }] }
        : {}),
      address: { dirName: `-${sessionId}`, fileName: `${sessionId}.jsonl` },
    }),
    listed: async (sessionId) => (sessionId === "lane-b" ? null : { customTitle: `${sessionId} title`, model: "opus", turnCount: 3 }),
    tasks: () => [task("lane-a", { acknowledgedAt: 5 }), task("lane-b", { state: "running" })],
    ...overrides,
  }
}

describe("readSessionCrew", () => {
  it("reports the whole crew from any member: the root first, then every member in the order they were started", async () => {
    const crew = await readSessionCrew("reviewer", sources())

    expect(crew?.rootId).toBe("coordinator")
    expect(crew?.sessionId).toBe("reviewer")
    expect(crew?.members.map((member) => [member.sessionId, member.parentId])).toEqual([
      ["coordinator", null],
      ["lane-a", "coordinator"],
      ["lane-b", "coordinator"],
      ["reviewer", "lane-a"],
    ])
  })

  it("carries each member's state, requests, machine, listing facts and result", async () => {
    const crew = await readSessionCrew("coordinator", sources())
    const [, laneA, laneB, reviewer] = crew!.members

    expect(laneA).toMatchObject({
      name: "w3-lane-a", startedAt: 10, device: null, outcome: "completed",
      customTitle: "lane-a title", model: "opus", turnCount: 3,
      address: { dirName: "-lane-a", fileName: "lane-a.jsonl" },
      result: { taskId: "task-lane-a", state: "completed", acknowledged: true },
    })
    expect(laneB).toMatchObject({ device: { id: "dev_1", name: "agentbox" }, result: { state: "running", acknowledged: false } })
    expect(laneB).not.toHaveProperty("customTitle")
    expect(reviewer).toMatchObject({ outcome: "needs_input", waiting: [expect.objectContaining({ requestId: "r1" })] })
  })

  it("leaves out members the caller may not see, with everything they started", async () => {
    const crew = await readSessionCrew("coordinator", sources({ canView: async (id) => id !== "lane-a" }))
    expect(crew?.members.map((member) => member.sessionId)).toEqual(["coordinator", "lane-b"])
  })

  it("reports a session nothing started and that started nothing as a crew of one", async () => {
    const crew = await readSessionCrew("solo", sources())
    expect(crew?.members.map((member) => member.sessionId)).toEqual(["solo"])
  })

  it("answers for a member as an unreachable session when its machine fails", async () => {
    const describe = vi.fn(async (sessionId: string) => {
      if (sessionId === "lane-b") throw new Error("device offline")
      return sources().describe(sessionId)
    })
    const crew = await readSessionCrew("coordinator", sources({ describe }))
    expect(crew?.members.find((member) => member.sessionId === "lane-b")).toMatchObject({
      outcome: "unreachable", error: "device offline", waiting: [], address: null,
    })
  })

  it("is null when the caller may not see the session asked about", async () => {
    expect(await readSessionCrew("lane-a", sources({ canView: async () => false }))).toBeNull()
  })
})
