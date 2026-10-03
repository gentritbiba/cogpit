// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../helpers", () => ({
  dirs: { PROJECTS_DIR: "/tmp/test-projects" },
  isWithinDir: vi.fn(),
  readdir: vi.fn(),
  open: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

const listProjectSessionFiles = vi.fn(async (_dirName: string): Promise<unknown[] | null> => null)
vi.mock("../../agents", () => ({
  storeForDirName: () => ({ listProjectSessionFiles }),
}))

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}))

vi.mock("node:fs/promises", () => ({
  stat: vi.fn(async () => ({ birthtime: new Date("2025-01-01") })),
}))

import { isWithinDir, readdir } from "../../helpers"
import { execFile } from "node:child_process"
import type { UseFn, Middleware } from "../../helpers"
import { registerWorktreeRoutes } from "../../routes/worktrees"
import { readFirstJsonLine, SESSION_HEADER_BYTES } from "../../routes/worktrees/worktreeUtils"
import {
  runWorktreeCommand,
  WORKTREE_COMMAND_MAX_BUFFER,
  WORKTREE_COMMAND_TIMEOUT_MS,
  WORKTREE_NETWORK_TIMEOUT_MS,
} from "../../routes/worktrees/worktreeIo"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedReaddir = vi.mocked(readdir)
const mockedExecFile = vi.mocked(execFile)

type CommandResult = (command: unknown, args: unknown) => string
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void

function mockCommandResults(getResult: CommandResult): void {
  mockedExecFile.mockImplementation(((...callArgs: unknown[]) => {
    const [command, args] = callArgs
    const callback = callArgs.at(-1) as ExecCallback
    try {
      callback(null, getResult(command, args), "")
    } catch (error) {
      callback(error as Error, "", "")
    }
    return {} as ReturnType<typeof execFile>
  }) as unknown as typeof execFile)
}

/** `git worktree list --porcelain` for a checkout at /repo and the given worktrees. */
function worktreeList(...worktrees: Array<{ path: string; branch?: string }>): string {
  return ["worktree /repo\nHEAD 0000000\nbranch refs/heads/main\n", ...worktrees.map(({ path, branch }) =>
    `worktree ${path}\nHEAD abc1234\n${branch ? `branch refs/heads/${branch}` : "detached"}\n`,
  )].join("\n") + "\n"
}

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

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      // git rev-parse --git-common-dir
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      // git symbolic-ref
      if (cmd === "git" && a.includes("symbolic-ref")) throw new Error("no remote")
      // git worktree list --porcelain
      if (cmd === "git" && a.includes("--porcelain")) {
        return (
          "worktree /repo/.claude/worktrees/fix-auth\n" +
          "HEAD abc1234\n" +
          "branch refs/heads/worktree-fix-auth\n\n"
        )
      }
      if (cmd === "git" && a.includes("status")) return "M file.ts\n"
      if (cmd === "git" && a.includes("rev-list")) return "2\n"
      if (cmd === "git" && a.includes("log")) return "fix auth bug\n"
      if (cmd === "git" && a[0] === "diff" && a.includes("--numstat")) return "10\t2\tsrc/auth.ts\n3\t0\tsrc/types.ts\n"
      if (cmd === "git" && a[0] === "diff" && a.includes("--name-only")) return ""
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
    expect(data[0].changedFiles).toEqual([
      { path: "src/auth.ts", status: "M", additions: 10, deletions: 2 },
      { path: "src/types.ts", status: "M", additions: 3, deletions: 0 },
    ])
  })

  it("lists every worktree in the worktree folder, whatever its branch, with the sessions run inside it", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)
    listProjectSessionFiles.mockImplementation(async (dirName) =>
      dirName === "-repo--claude-worktrees-inventory-admin"
        ? [
          { fileName: "old.jsonl", mtimeMs: 1 },
          { fileName: "new.jsonl", sessionId: "new", mtimeMs: 2 },
        ]
        : null)

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      if (cmd === "git" && a.includes("symbolic-ref")) throw new Error("no remote")
      if (cmd === "git" && a.includes("--porcelain") && a.includes("worktree")) {
        return worktreeList(
          { path: "/repo/.claude/worktrees/inventory-admin", branch: "feat/inventory-alert" },
          { path: "/repo/.worktrees/spike" },
          { path: "/Users/me/elsewhere", branch: "fix/other" },
        )
      }
      return ""
    })

    const { req, res } = createMockReqRes("GET", "/-repo")
    await handler(req as any, res as any, vi.fn())

    const data = JSON.parse(res._getData())
    expect(data.map((wt: { name: string; branch: string }) => [wt.name, wt.branch])).toEqual([
      ["inventory-admin", "feat/inventory-alert"],
      ["spike", ""],
    ])
    expect(data[0].linkedSessions).toEqual([
      { dirName: "-repo--claude-worktrees-inventory-admin", sessionId: "new" },
      { dirName: "-repo--claude-worktrees-inventory-admin", sessionId: "old" },
    ])
    listProjectSessionFiles.mockResolvedValue(null)
  })

  it("returns empty array when project is not a git repo", async () => {
    mockedIsWithinDir.mockReturnValue(true)

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) throw new Error("not a git repo")
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

    // resolveProjectCwd will read a session JSONL whose cwd is a worktree dir
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

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      if (cmd === "git" && a.includes("symbolic-ref")) throw new Error("no remote")
      if (cmd === "git" && a.includes("--porcelain")) {
        return (
          "worktree /repo/.claude/worktrees/fix-auth\n" +
          "HEAD abc1234\n" +
          "branch refs/heads/worktree-fix-auth\n\n"
        )
      }
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

    // Only bounded headers are read: the project path's, then each session's branch.
    for (const [buffer, offset, length, position] of mockFh.read.mock.calls) {
      expect([4096, 8192]).toContain(buffer.length)
      expect([offset, length, position]).toEqual([0, buffer.length, 0])
    }

    // Verify --git-common-dir was called (not --show-toplevel)
    expect(mockedExecFile).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--git-common-dir"],
      expect.any(Object),
      expect.any(Function),
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

  function mockRepoWith(...worktrees: Array<{ path: string; branch?: string }>) {
    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      if (cmd === "git" && a.includes("--porcelain")) return worktreeList(...worktrees)
      return "" as any
    })
  }

  function gitCalls(): string[][] {
    return mockedExecFile.mock.calls
      .filter(([command]) => command === "git")
      .map(([, args]) => args as string[])
  }

  it("removes a worktree and its generated branch", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)
    mockRepoWith({ path: "/repo/.claude/worktrees/fix-auth", branch: "worktree-fix-auth" })

    const { req, res } = createMockReqRes("DELETE", "/my-project/fix-auth", JSON.stringify({ force: false }))
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.ok).toBe(true)
    expect(gitCalls()).toContainEqual(["worktree", "remove", "/repo/.claude/worktrees/fix-auth"])
    expect(gitCalls()).toContainEqual(["branch", "-d", "worktree-fix-auth"])
  })

  it("keeps a branch someone named when removing its worktree", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)
    mockRepoWith({ path: "/repo/.claude/worktrees/fix-auth", branch: "feat/auth" })

    const { req, res } = createMockReqRes("DELETE", "/my-project/fix-auth", JSON.stringify({ force: true }))
    await handler(req as any, res as any, vi.fn())

    expect(res.statusCode).toBe(200)
    expect(gitCalls()).toContainEqual(["worktree", "remove", "--force", "/repo/.claude/worktrees/fix-auth"])
    expect(gitCalls().some((args) => args[0] === "branch")).toBe(false)
  })

  it("returns 404 for a worktree the project does not have", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)
    mockRepoWith()

    const { req, res } = createMockReqRes("DELETE", "/my-project/fix-auth", JSON.stringify({ force: false }))
    await handler(req as any, res as any, vi.fn())

    expect(res.statusCode).toBe(404)
    expect(gitCalls().some((args) => args[0] === "worktree" && args[1] === "remove")).toBe(false)
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

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      return "" as any
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

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      return "" as any
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

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      if (cmd === "git" && a.includes("--porcelain")) {
        return worktreeList({ path: "/repo/.claude/worktrees/fix-auth", branch: "worktree-fix-auth" })
      }
      if (cmd === "git" && a.includes("push")) return ""
      if (cmd === "gh" && a.includes("pr")) return "https://github.com/owner/repo/pull/1\n"
      return "" as any
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

    expect(mockedExecFile).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "create",
        "--title",
        "Fix auth",
        "--head",
        "worktree-fix-auth",
        "--body",
        "",
      ],
      expect.any(Object),
      expect.any(Function),
    )

    const networkCalls = mockedExecFile.mock.calls.filter(([command, args]) => {
      const commandArgs = args as string[]
      return (command === "git" && commandArgs.includes("push")) || command === "gh"
    })
    expect(networkCalls).toHaveLength(2)
    for (const call of networkCalls) {
      expect(call[2]).toMatchObject({ timeout: WORKTREE_NETWORK_TIMEOUT_MS })
    }
  })

  it("rejects request bodies larger than the route limit", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)
    mockCommandResults((cmd: unknown, args: unknown) => {
      const commandArgs = args as string[]
      if (cmd === "git" && commandArgs.includes("--git-common-dir")) return "/repo/.git\n"
      return ""
    })

    const oversizedBody = JSON.stringify({
      worktreeName: "fix-auth",
      body: "x".repeat(65 * 1024),
    })
    const { req, res } = createMockReqRes("POST", "/my-project/create-pr", oversizedBody)
    await handler(req as any, res as any, vi.fn())

    expect(res.statusCode).toBe(413)
    expect(JSON.parse(res._getData())).toEqual({ error: "Request body too large" })
  })
})

describe("POST /api/worktrees/:dirName/cleanup", () => {
  let handler: Middleware

  beforeEach(() => {
    vi.clearAllMocks()
    const routes: Record<string, Middleware> = {}
    const use: UseFn = (path: string, h: Middleware) => { routes[path] = h }
    registerWorktreeRoutes(use)
    handler = routes["/api/worktrees"]
  })

  it("lists stale worktrees when confirm is false", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)

    const { stat } = await import("node:fs/promises")
    const mockedStat = vi.mocked(stat)
    // Old birthtime (stale)
    mockedStat.mockResolvedValue({ birthtime: new Date("2024-01-01") } as any)

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      if (cmd === "git" && a.includes("worktree") && a.includes("--porcelain")) {
        return (
          "worktree /repo/.claude/worktrees/old-branch\n" +
          "HEAD aaa1111\n" +
          "branch refs/heads/worktree-old-branch\n\n"
        )
      }
      // git status --porcelain: clean (no changes = eligible for stale)
      if (cmd === "git" && a.includes("status")) return ""
      return "" as any
    })

    const { req, res } = createMockReqRes(
      "POST",
      "/my-project/cleanup",
      JSON.stringify({ confirm: false, maxAgeDays: 7 })
    )
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.stale).toHaveLength(1)
    expect(data.stale[0].name).toBe("old-branch")
    expect(data.stale[0].branch).toBe("worktree-old-branch")
  })

  it("excludes dirty worktrees from stale list", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)

    const { stat } = await import("node:fs/promises")
    const mockedStat = vi.mocked(stat)
    mockedStat.mockResolvedValue({ birthtime: new Date("2024-01-01") } as any)

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      if (cmd === "git" && a.includes("--porcelain")) {
        return (
          "worktree /repo/.claude/worktrees/dirty-branch\n" +
          "HEAD bbb2222\n" +
          "branch refs/heads/worktree-dirty-branch\n\n"
        )
      }
      // git status: has uncommitted changes
      if (cmd === "git" && a.includes("status")) return "M dirty-file.ts\n"
      return "" as any
    })

    const { req, res } = createMockReqRes(
      "POST",
      "/my-project/cleanup",
      JSON.stringify({ confirm: false })
    )
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.stale).toHaveLength(0)
  })

  it("returns empty stale list when no worktrees exist", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      if (cmd === "git" && a.includes("--porcelain")) return ""
      return "" as any
    })

    const { req, res } = createMockReqRes(
      "POST",
      "/my-project/cleanup",
      JSON.stringify({ confirm: false })
    )
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.stale).toHaveLength(0)
  })

  it("removes confirmed stale worktrees", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)

    const { stat } = await import("node:fs/promises")
    const mockedStat = vi.mocked(stat)
    mockedStat.mockResolvedValue({ birthtime: new Date("2024-01-01") } as any)

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      if (cmd === "git" && a.includes("worktree") && a.includes("--porcelain")) {
        return (
          "worktree /repo/.claude/worktrees/old-branch\n" +
          "HEAD aaa1111\n" +
          "branch refs/heads/worktree-old-branch\n\n"
        )
      }
      if (cmd === "git" && a.includes("status")) return ""
      if (cmd === "git" && a.includes("worktree") && a.includes("remove")) return "" as any
      if (cmd === "git" && a.includes("branch")) return "" as any
      return "" as any
    })

    const { req, res } = createMockReqRes(
      "POST",
      "/my-project/cleanup",
      JSON.stringify({ confirm: true, names: ["old-branch"] })
    )
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.removed).toEqual(["old-branch"])
    expect(data.errors).toEqual([])
  })

  it("returns 400 for invalid JSON body", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    mockedReaddir.mockResolvedValue([] as any)

    mockCommandResults((cmd: unknown, args: unknown) => {
      const a = args as string[]
      if (cmd === "git" && a.includes("--git-common-dir")) return "/repo/.git\n"
      return "" as any
    })

    const { req, res } = createMockReqRes(
      "POST",
      "/my-project/cleanup",
      "not valid json{{"
    )
    const next = vi.fn()
    await handler(req as any, res as any, next)

    expect(res.statusCode).toBe(400)
    const data = JSON.parse(res._getData())
    expect(data.error).toBe("Invalid JSON body")
  })
})

describe("worktree I/O bounds", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("runs commands asynchronously with explicit output, timeout, and prompt bounds", async () => {
    mockCommandResults(() => "ok\n")

    await expect(runWorktreeCommand("git", ["status"], { cwd: "/repo" })).resolves.toBe("ok\n")

    expect(mockedExecFile).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({
        cwd: "/repo",
        encoding: "utf-8",
        maxBuffer: WORKTREE_COMMAND_MAX_BUFFER,
        timeout: WORKTREE_COMMAND_TIMEOUT_MS,
        windowsHide: true,
        env: expect.objectContaining({
          GCM_INTERACTIVE: "Never",
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
        }),
      }),
      expect.any(Function),
    )
  })

  it("leaves the event loop responsive while a command is pending", async () => {
    let completeCommand: ExecCallback | undefined
    mockedExecFile.mockImplementationOnce(((...callArgs: unknown[]) => {
      completeCommand = callArgs.at(-1) as ExecCallback
      return {} as ReturnType<typeof execFile>
    }) as unknown as typeof execFile)

    let settled = false
    const command = runWorktreeCommand("git", ["status"], { cwd: "/repo" })
      .then((output) => {
        settled = true
        return output
      })

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    completeCommand?.(null, "ready\n", "")
    await expect(command).resolves.toBe("ready\n")
  })

  it("reads only a fixed-size JSONL header", async () => {
    const header = JSON.stringify({ cwd: "/repo", gitBranch: "worktree-fix-auth" })
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      Buffer.from(`${header}\n${"x".repeat(10_000)}`).copy(buffer, offset, 0, length)
      return { bytesRead: Math.min(length, Buffer.byteLength(header) + 1 + 10_000) }
    })
    const close = vi.fn(async () => undefined)
    const { open } = await import("../../helpers")
    vi.mocked(open).mockResolvedValue({ read, close } as any)

    await expect(readFirstJsonLine("/sessions/session.jsonl")).resolves.toEqual({
      cwd: "/repo",
      gitBranch: "worktree-fix-auth",
    })
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ byteLength: SESSION_HEADER_BYTES }),
      0,
      SESSION_HEADER_BYTES,
      0,
    )
    expect(close).toHaveBeenCalledOnce()
  })
})
