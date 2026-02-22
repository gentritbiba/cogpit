// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../helpers", () => ({
  dirs: { PROJECTS_DIR: "/tmp/test-projects" },
  isWithinDir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  open: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock("node:fs", () => ({
  statSync: vi.fn(() => ({ birthtime: new Date("2025-01-01") })),
}))

import { isWithinDir, readdir } from "../../helpers"
import { execSync, execFileSync } from "node:child_process"
import type { UseFn, Middleware } from "../../helpers"
import { registerWorktreeRoutes } from "../../routes/worktrees"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedReaddir = vi.mocked(readdir)
const mockedExecSync = vi.mocked(execSync)
const mockedExecFileSync = vi.mocked(execFileSync)

/**
 * Creates mock req/res objects. When body is provided, the req will emit
 * "data" and "end" events as soon as the handler registers listeners for them
 * (using a microtask). This handles the case where the handler awaits something
 * before registering body listeners.
 */
function createMockReqRes(method: string, url: string, body?: string) {
  let endData = ""
  let statusCode = 200
  const headers: Record<string, string> = {}

  const dataHandlers: ((chunk: string) => void)[] = []
  const endHandlers: (() => void)[] = []
  let bodyFired = false

  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") {
        dataHandlers.push(handler as (chunk: string) => void)
      }
      if (event === "end") {
        endHandlers.push(handler as () => void)
        // As soon as "end" is registered, fire queued body on next microtask
        if (body !== undefined && !bodyFired) {
          bodyFired = true
          Promise.resolve().then(() => {
            if (body) dataHandlers.forEach(h => h(body))
            endHandlers.forEach(h => h())
          })
        }
      }
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
  return { req, res }
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

    // execSync is used for: git rev-parse, git symbolic-ref, git worktree list --porcelain
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git-common-dir")) return "/repo/.git\n"
      if (cmd.includes("symbolic-ref")) throw new Error("no remote")
      if (cmd.includes("worktree list --porcelain")) {
        return (
          "worktree /repo/.claude/worktrees/fix-auth\n" +
          "HEAD abc1234\n" +
          "branch refs/heads/worktree-fix-auth\n\n"
        )
      }
      return ""
    })

    // execFileSync is used for: git status --porcelain, git rev-list, git log
    mockedExecFileSync.mockImplementation((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("status")) return "M file.ts\n"
      if (cmd === "git" && a.includes("rev-list")) return "2\n"
      if (cmd === "git" && a.includes("log")) return "fix auth bug\n"
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
      if (cmd.includes("git-common-dir")) throw new Error("not a git repo")
      return ""
    })

    mockedReaddir.mockResolvedValue([] as any)

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

  it("normalizes worktree cwd to main repo root via --git-common-dir", async () => {
    mockedIsWithinDir.mockReturnValue(true)

    // resolveProjectPath will read a session JSONL whose cwd is a worktree dir
    const mockFh = { read: vi.fn().mockResolvedValue({ bytesRead: 100 }), close: vi.fn() }
    const cwdJson = JSON.stringify({ cwd: "/repo/.claude/worktrees/fix-auth" })
    mockFh.read.mockImplementation((_buf: Buffer) => {
      const b = Buffer.from(cwdJson + "\n")
      b.copy(_buf)
      return Promise.resolve({ bytesRead: b.length })
    })
    const { open } = await import("../../helpers")
    vi.mocked(open).mockResolvedValue(mockFh as any)
    mockedReaddir.mockResolvedValue(["session1.jsonl"] as any)

    mockedExecSync.mockImplementation((cmd: string) => {
      // --git-common-dir from worktree returns path to main .git
      if (cmd.includes("git-common-dir")) return "/repo/.git\n"
      if (cmd.includes("symbolic-ref")) throw new Error("no remote")
      if (cmd.includes("worktree list --porcelain")) {
        return (
          "worktree /repo/.claude/worktrees/fix-auth\n" +
          "HEAD abc1234\n" +
          "branch refs/heads/worktree-fix-auth\n\n"
        )
      }
      return ""
    })

    mockedExecFileSync.mockImplementation((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("status")) return ""
      if (cmd === "git" && a.includes("rev-list")) return "1\n"
      if (cmd === "git" && a.includes("log")) return "fix auth\n"
      if (cmd === "git" && a.includes("diff")) return ""
      return ""
    })

    const { req, res } = createMockReqRes("GET", "/test-project")
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data).toHaveLength(1)
    expect(data[0].name).toBe("fix-auth")

    // Verify --git-common-dir was called (not --show-toplevel)
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git-common-dir"),
      expect.any(Object)
    )
  })
})

describe("DELETE /api/worktrees/:dirName/:worktreeName", () => {
  let handler: Middleware

  beforeEach(() => {
    vi.clearAllMocks()
    const routes: Record<string, Middleware> = {}
    const use: UseFn = (path: string, h: Middleware) => { routes[path] = h }
    registerWorktreeRoutes(use)
    handler = routes["/api/worktrees"]
  })

  it("rejects invalid worktree names", async () => {
    mockedIsWithinDir.mockReturnValue(true)

    // Use a name with semicolon (invalid char) — URL encodes it so pathParts.length === 2
    const { req, res } = createMockReqRes("DELETE", "/my-project/evil%3Brm%20-rf")
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(400)
    const data = JSON.parse(res._getData())
    expect(data.error).toBe("Invalid worktree name")
  })

  it("removes a worktree successfully", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)

    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git-common-dir")) return "/repo/.git\n"
      return ""
    })
    mockedExecFileSync.mockReturnValue("" as any)

    const { req, res } = createMockReqRes("DELETE", "/my-project/fix-auth", JSON.stringify({ force: false }))
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.ok).toBe(true)
  })
})

describe("POST /api/worktrees/:dirName/create-pr", () => {
  let handler: Middleware

  beforeEach(() => {
    vi.clearAllMocks()
    const routes: Record<string, Middleware> = {}
    const use: UseFn = (path: string, h: Middleware) => { routes[path] = h }
    registerWorktreeRoutes(use)
    handler = routes["/api/worktrees"]
  })

  it("returns 400 when worktreeName is missing", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)

    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git-common-dir")) return "/repo/.git\n"
      return ""
    })

    const { req, res } = createMockReqRes("POST", "/my-project/create-pr", JSON.stringify({ title: "My PR" }))
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(400)
    const data = JSON.parse(res._getData())
    expect(data.error).toBe("worktreeName is required")
  })

  it("rejects invalid worktree names in create-pr", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)

    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git-common-dir")) return "/repo/.git\n"
      return ""
    })

    const { req, res } = createMockReqRes(
      "POST",
      "/my-project/create-pr",
      JSON.stringify({ worktreeName: "evil; rm -rf /" })
    )
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(400)
    const data = JSON.parse(res._getData())
    expect(data.error).toBe("Invalid worktree name")
  })

  it("creates a PR successfully", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)

    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("git-common-dir")) return "/repo/.git\n"
      return ""
    })
    mockedExecFileSync.mockImplementation((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("push")) return ""
      if (cmd === "gh" && a.includes("pr")) return "https://github.com/owner/repo/pull/1\n"
      return ""
    })

    const { req, res } = createMockReqRes(
      "POST",
      "/my-project/create-pr",
      JSON.stringify({ worktreeName: "fix-auth", title: "Fix auth" })
    )
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.url).toBe("https://github.com/owner/repo/pull/1")
  })
})
