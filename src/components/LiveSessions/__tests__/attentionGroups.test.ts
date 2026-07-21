import { describe, it, expect } from "vitest"
import { classifyAttention, workingChip } from "../attentionGroups"
import type { ActiveSessionInfo, RunningProcess } from "../types"

function makeSession(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "-Users-me-project",
    projectShortName: "project",
    fileName: "session.jsonl",
    sessionId: "sess-1",
    lastModified: "2026-07-18T10:00:00Z",
    size: 100,
    ...overrides,
  }
}

function procs(...ids: string[]): Map<string, RunningProcess> {
  return new Map(ids.map((id) => [id, {
    pid: 1, memMB: 100, cpu: 1, sessionId: id, tty: "ttys001", args: "claude", startTime: "10:00",
  }]))
}

describe("classifyAttention", () => {
  it("puts deferred sessions in needsYou with a permission reason", () => {
    const s = makeSession({ agentStatus: "deferred" })
    const { needsYou, working } = classifyAttention([s], new Map(), new Set())
    expect(needsYou).toEqual([{ session: s, reason: "permission" }])
    expect(working).toEqual([])
  })

  it("puts live idle sessions in needsYou as waiting", () => {
    const cli = makeSession({ sessionId: "cli", agentStatus: "idle" })
    const native = makeSession({ sessionId: "native", isActive: true, agentStatus: "idle" })
    const { needsYou } = classifyAttention([cli, native], procs("cli"), new Set())
    expect(needsYou.map((i) => i.reason)).toEqual(["waiting", "waiting"])
  })

  it("puts actively running sessions in working", () => {
    const thinking = makeSession({ sessionId: "a", agentStatus: "thinking" })
    const tool = makeSession({ sessionId: "b", agentStatus: "tool_use", agentToolName: "Bash" })
    const { needsYou, working } = classifyAttention([thinking, tool], procs("a", "b"), new Set())
    expect(needsYou).toEqual([])
    expect(working.map((s) => s.sessionId)).toEqual(["a", "b"])
  })

  it("treats a live session with unknown status as working, never needsYou", () => {
    const s = makeSession({ sessionId: "x" })
    const { needsYou, working } = classifyAttention([s], procs("x"), new Set())
    expect(needsYou).toEqual([])
    expect(working.map((w) => w.sessionId)).toEqual(["x"])
  })

  it("surfaces newly completed sessions as done, even after the process exits", () => {
    const withProc = makeSession({ sessionId: "a", agentStatus: "completed" })
    const procGone = makeSession({ sessionId: "b", agentStatus: "completed" })
    const { needsYou } = classifyAttention([withProc, procGone], procs("a"), new Set(["a", "b"]))
    expect(needsYou.map((i) => i.reason)).toEqual(["done", "done"])
  })

  it("excludes stale completed sessions that did not just finish", () => {
    const s = makeSession({ sessionId: "a", agentStatus: "completed" })
    const { needsYou, working } = classifyAttention([s], procs("a"), new Set())
    expect(needsYou).toEqual([])
    expect(working).toEqual([])
  })

  it("excludes recent dead sessions entirely", () => {
    const s = makeSession()
    const { needsYou, working } = classifyAttention([s], new Map(), new Set())
    expect(needsYou).toEqual([])
    expect(working).toEqual([])
  })

  it("excludes working teammates but keeps deferred teammates", () => {
    const teammate = { teamName: "team", agentName: "cc-research", teamLeadSessionId: "lead" }
    const busy = makeSession({ sessionId: "t1", agentStatus: "tool_use", ...teammate })
    const blocked = makeSession({ sessionId: "t2", agentStatus: "deferred", ...teammate })
    const { needsYou, working } = classifyAttention([busy, blocked], procs("t1", "t2"), new Set())
    expect(working).toEqual([])
    expect(needsYou).toEqual([{ session: blocked, reason: "permission" }])
  })

  it("orders each bucket newest-first", () => {
    const older = makeSession({ sessionId: "old", agentStatus: "thinking", lastModified: "2026-07-18T09:00:00Z" })
    const newer = makeSession({ sessionId: "new", agentStatus: "thinking", lastModified: "2026-07-18T11:00:00Z" })
    const { working } = classifyAttention([older, newer], procs("old", "new"), new Set())
    expect(working.map((s) => s.sessionId)).toEqual(["new", "old"])
  })
})

describe("workingChip", () => {
  it("shows the tool name during tool use", () => {
    expect(workingChip(makeSession({ agentStatus: "tool_use", agentToolName: "Bash" }))).toBe("Bash")
  })

  it("falls back to a generic label when the tool name is missing", () => {
    expect(workingChip(makeSession({ agentStatus: "tool_use" }))).toBe("Tool")
  })

  it("labels phases and defaults to Running", () => {
    expect(workingChip(makeSession({ agentStatus: "thinking" }))).toBe("Thinking")
    expect(workingChip(makeSession())).toBe("Running")
  })
})
