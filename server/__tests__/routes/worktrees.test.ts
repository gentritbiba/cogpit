// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../helpers", () => ({
  dirs: { PROJECTS_DIR: "/tmp/test-projects" },
  isWithinDir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}))

vi.mock("node:fs", () => ({
  statSync: vi.fn(() => ({ birthtime: new Date("2025-01-01") })),
}))

import { isWithinDir, readdir } from "../../helpers"
import { execSync } from "node:child_process"
import type { UseFn, Middleware } from "../../helpers"
import { registerWorktreeRoutes } from "../../routes/worktrees"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedReaddir = vi.mocked(readdir)
const mockedExecSync = vi.mocked(execSync)

function createMockReqRes(method: string, url: string, body?: string) {
  const dataHandlers: ((chunk: string) => void)[] = []
  const endHandlers: (() => void)[] = []
  let endData = ""
  let statusCode = 200
  const headers: Record<string, string> = {}
  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: string) => void)
      if (event === "end") endHandlers.push(handler as () => void)
      return req
    }),
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  }
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v }),
    end: vi.fn((data?: string) => { endData = data || "" }),
    getHeader: vi.fn((k: string) => headers[k]),
    _getData: () => endData,
  }
  const fire = () => {
    if (body) dataHandlers.forEach(h => h(body))
    endHandlers.forEach(h => h())
  }
  return { req, res, fire }
}

describe("GET /api/worktrees/:dirName", () => {
  let handler: Middleware

  beforeEach(() => {
    vi.clearAllMocks()
    const routes: Record<string, Middleware> = {}
    const use: UseFn = (path: string, h: Middleware) => { routes[path] = h }
    registerWorktreeRoutes(use)
    handler = routes["/api/worktrees"]
  })

  it("returns worktree list for a project", async () => {
    mockedIsWithinDir.mockReturnValue(true)

    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return "/repo"
      if (cmd.includes("symbolic-ref")) throw new Error("no remote")
      if (cmd.includes("worktree list --porcelain")) {
        return (
          "worktree /repo/.claude/worktrees/fix-auth\n" +
          "HEAD abc1234\n" +
          "branch refs/heads/worktree-fix-auth\n\n"
        )
      }
      if (cmd.includes("git status --porcelain")) return "M file.ts\n"
      if (cmd.includes("rev-list --count")) return "2\n"
      if (cmd.includes("git log")) return "fix auth bug\n"
      return ""
    })

    mockedReaddir.mockResolvedValue([] as any)

    const { req, res } = createMockReqRes("GET", "/fix-auth")
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe("fix-auth")
    expect(data[0].isDirty).toBe(true)
    expect(data[0].branch).toBe("worktree-fix-auth")
  })

  it("returns empty array when project is not a git repo", async () => {
    mockedIsWithinDir.mockReturnValue(true)

    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) throw new Error("not a git repo")
      return ""
    })

    const { req, res } = createMockReqRes("GET", "/not-a-repo")
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data).toEqual([])
  })

  it("returns 403 when path is outside projects dir", async () => {
    mockedIsWithinDir.mockReturnValue(false)

    const { req, res } = createMockReqRes("GET", "/evil-project")
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(403)
    const data = JSON.parse(res._getData())
    expect(data.error).toBe("Access denied")
  })

  it("calls next() for unhandled routes", async () => {
    const { req, res } = createMockReqRes("GET", "/foo/bar/extra")
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(next).toHaveBeenCalled()
  })
})
