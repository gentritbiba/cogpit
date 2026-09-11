import { describe, expect, it } from "vitest"

import { mergeSessions, projectScopeOptions, scopeSessions } from "../projectScope"
import type { ActiveSessionInfo, RunningProcess } from "../types"

function session(sessionId: string, overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    dirName: "-home-me-app",
    projectShortName: "app",
    fileName: `${sessionId}.jsonl`,
    sessionId,
    cwd: "/home/me/app",
    lastModified: "2026-09-10T10:00:00Z",
    size: 100,
    ...overrides,
  }
}

function proc(sessionId: string): RunningProcess {
  return { pid: 1, memMB: 10, cpu: 0, sessionId, tty: "ttys001", startTime: "10:00" }
}

describe("projectScopeOptions", () => {
  it("lists one option per project, newest project first, with counts", () => {
    const sessions = [
      session("old-lib", { dirName: "-home-me-lib", cwd: "/home/me/lib", lastModified: "2026-09-01T10:00:00Z" }),
      session("app-1", { lastModified: "2026-09-11T10:00:00Z" }),
      session("app-2", { lastModified: "2026-09-10T10:00:00Z" }),
    ]
    const procs = new Map([["app-1", proc("app-1")]])

    const options = projectScopeOptions(sessions, procs, {}, new Set(["app-2"]))

    expect(options.map((option) => option.key)).toEqual(["me/app", "me/lib"])
    expect(options[0]).toMatchObject({
      dirName: "-home-me-app",
      cwd: "/home/me/app",
      dirNames: ["-home-me-app"],
      total: 2,
      live: 1,
      needsYou: 1,
    })
    expect(options[1]).toMatchObject({ total: 1, live: 0, needsYou: 0 })
  })

  it("names the option after the checkout, not a worktree, and remembers every directory", () => {
    const sessions = [
      session("wt", {
        dirName: "-home-me-app--worktrees-feature",
        cwd: "/home/me/app/.worktrees/feature",
        lastModified: "2026-09-11T10:00:00Z",
      }),
      session("main"),
    ]

    const [option] = projectScopeOptions(sessions, new Map(), { "-home-me-app": "App" }, new Set())

    expect(option).toMatchObject({
      key: "me/app",
      customName: "App",
      dirName: "-home-me-app",
      cwd: "/home/me/app",
      dirNames: ["-home-me-app--worktrees-feature", "-home-me-app"],
    })
  })
})

describe("scopeSessions", () => {
  it("keeps every session for the all-projects scope and only the project's own otherwise", () => {
    const sessions = [session("a"), session("b", { dirName: "-home-me-lib", cwd: "/home/me/lib" })]

    expect(scopeSessions(sessions, null)).toBe(sessions)
    expect(scopeSessions(sessions, "me/lib").map((s) => s.sessionId)).toEqual(["b"])
    expect(scopeSessions(sessions, "me/none")).toEqual([])
  })
})

describe("mergeSessions", () => {
  it("adds older sessions the list lacks and keeps everything newest first", () => {
    const listed = [session("new", { lastModified: "2026-09-11T10:00:00Z" })]
    const older = [
      session("new", { lastModified: "2026-09-11T10:00:00Z" }),
      session("old", { lastModified: "2026-09-01T10:00:00Z" }),
    ]

    expect(mergeSessions(listed, older).map((s) => s.sessionId)).toEqual(["new", "old"])
    expect(mergeSessions(listed, [])).toBe(listed)
    expect(mergeSessions(listed, [listed[0]])).toBe(listed)
  })
})
