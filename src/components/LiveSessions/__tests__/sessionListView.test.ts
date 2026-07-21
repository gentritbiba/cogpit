import { describe, it, expect } from "vitest"
import {
  projectGroupKey,
  sessionGroupKey,
  groupByProject,
  isSessionLive,
  visibleRowCount,
  UNKNOWN_PROJECT_LABEL,
} from "../sessionListView"
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

function makeProc(sessionId: string): RunningProcess {
  return {
    pid: 123,
    memMB: 100,
    cpu: 1,
    sessionId,
    tty: "ttys001",
    args: "claude",
    startTime: "10:00",
  }
}

describe("projectGroupKey", () => {
  it("shows the last two path segments", () => {
    expect(projectGroupKey("/Users/me/work/my-app")).toBe("work/my-app")
  })

  it("maps worktree paths to their parent project", () => {
    expect(projectGroupKey("/Users/me/my-app/.worktrees/fix-bug")).toBe("me/my-app")
  })

  it("falls back to a label for empty paths instead of an empty group name", () => {
    expect(projectGroupKey("")).toBe(UNKNOWN_PROJECT_LABEL)
  })
})

describe("sessionGroupKey", () => {
  it("uses cwd when present", () => {
    const s = makeSession({ cwd: "/Users/me/work/my-app" })
    expect(sessionGroupKey(s)).toBe("work/my-app")
  })

  it("falls back to the dirName-derived path when cwd is an empty string", () => {
    const s = makeSession({ cwd: "", dirName: "-Users-me-project" })
    expect(sessionGroupKey(s)).toBe("me/project")
  })
})

describe("groupByProject", () => {
  it("groups sessions by project and keeps newest-first order", () => {
    const a = makeSession({ sessionId: "a", cwd: "/w/app1", lastModified: "2026-07-18T09:00:00Z" })
    const b = makeSession({ sessionId: "b", cwd: "/w/app2", lastModified: "2026-07-18T11:00:00Z" })
    const c = makeSession({ sessionId: "c", cwd: "/w/app1", lastModified: "2026-07-18T10:00:00Z" })
    const groups = groupByProject([a, b, c])
    expect([...groups.keys()]).toEqual(["/w/app2", "/w/app1"])
    expect(groups.get("/w/app1")!.map((s) => s.sessionId)).toEqual(["c", "a"])
  })
})

describe("isSessionLive", () => {
  it("is live for native app-server sessions", () => {
    expect(isSessionLive(makeSession({ isActive: true }), new Map())).toBe(true)
  })

  it("is live for a tracked process that has not completed", () => {
    const s = makeSession({ sessionId: "x", agentStatus: "thinking" })
    expect(isSessionLive(s, new Map([["x", makeProc("x")]]))).toBe(true)
  })

  it("is not live for a tracked process that completed", () => {
    const s = makeSession({ sessionId: "x", agentStatus: "completed" })
    expect(isSessionLive(s, new Map([["x", makeProc("x")]]))).toBe(false)
  })

  it("is not live without a process or native activity", () => {
    expect(isSessionLive(makeSession(), new Map())).toBe(false)
  })
})

describe("visibleRowCount", () => {
  const dead = (id: string) => makeSession({ sessionId: id })

  it("returns baseCount when no live sessions are buried", () => {
    const sessions = [dead("a"), dead("b"), dead("c")]
    expect(visibleRowCount(sessions, new Map(), 5)).toBe(5)
  })

  it("extends the window so a live session below the fold stays visible", () => {
    const sessions = [
      dead("a"), dead("b"), dead("c"), dead("d"), dead("e"),
      dead("f"),
      makeSession({ sessionId: "live", isActive: true }),
      dead("g"),
    ]
    expect(visibleRowCount(sessions, new Map(), 5)).toBe(7)
  })
})
