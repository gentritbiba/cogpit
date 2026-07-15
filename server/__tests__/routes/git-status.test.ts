// @vitest-environment node
import { execFile as execFileCallback } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import { parseGitStatus, registerGitStatusRoutes, relativizeToCwd } from "../../routes/git-status"

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function getHandler(): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (path, candidate) => {
    if (path === "/api/git-status") handler = candidate
  }
  registerGitStatusRoutes(use)
  if (!handler) throw new Error("Git status route was not registered")
  return handler
}

async function request(url: string) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string }
  req.method = "GET"
  req.url = url
  let body = ""
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { body = value ?? "" }),
  }
  await getHandler()(req as never, res as never, vi.fn())
  return { status: res.statusCode, data: JSON.parse(body) as Record<string, unknown> }
}

describe("git status route", () => {
  it("parses branch divergence and rename records", () => {
    expect(parseGitStatus("## feature...origin/feature [ahead 2, behind 1]\0R  src/new.ts\0src/old.ts\0 M README.md\0"))
      .toEqual({
        branch: "feature",
        upstream: "origin/feature",
        ahead: 2,
        behind: 1,
        detached: false,
        files: [
          { path: "src/new.ts", originalPath: "src/old.ts", indexStatus: "R", workTreeStatus: " " },
          { path: "README.md", indexStatus: " ", workTreeStatus: "M" },
        ],
      })
  })

  it("reports the current branch and working-tree files", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogpit-git-status-"))
    temporaryDirectories.push(root)
    await execFile("git", ["init", "-b", "main"], { cwd: root })
    await writeFile(join(root, "tracked.txt"), "one\n", "utf-8")
    await execFile("git", ["add", "tracked.txt"], { cwd: root })
    await execFile("git", ["-c", "user.name=Cogpit Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], { cwd: root })
    await writeFile(join(root, "tracked.txt"), "two\n", "utf-8")

    const response = await request(`/api/git-status?cwd=${encodeURIComponent(root)}`)

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ isRepository: true, branch: "main", ahead: 0, behind: 0 })
    expect(response.data.files).toEqual([
      { path: "tracked.txt", indexStatus: " ", workTreeStatus: "M" },
    ])
  })

  it("relativizes root-relative paths and drops entries outside the cwd", () => {
    const files = [
      { path: "packages/app/src/index.ts", indexStatus: " ", workTreeStatus: "M" },
      { path: "packages/app/renamed.ts", originalPath: "packages/app/old.ts", indexStatus: "R", workTreeStatus: " " },
      { path: "packages/other/file.ts", indexStatus: " ", workTreeStatus: "M" },
      { path: "packages/app/moved-in.ts", originalPath: "packages/other/out.ts", indexStatus: "R", workTreeStatus: " " },
    ]

    expect(relativizeToCwd(files, "/repo", join("/repo", "packages", "app"))).toEqual([
      { path: "src/index.ts", indexStatus: " ", workTreeStatus: "M" },
      { path: "renamed.ts", originalPath: "old.ts", indexStatus: "R", workTreeStatus: " " },
      { path: "moved-in.ts", indexStatus: "R", workTreeStatus: " " },
    ])
    expect(relativizeToCwd(files, "/repo", "/repo")).toEqual(files)
  })

  it("reports paths relative to a subdirectory cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogpit-git-subdir-"))
    temporaryDirectories.push(root)
    await execFile("git", ["init", "-b", "main"], { cwd: root })
    await mkdir(join(root, "packages", "app"), { recursive: true })
    await writeFile(join(root, "top-level.txt"), "root\n", "utf-8")
    await writeFile(join(root, "packages", "app", "nested.txt"), "one\n", "utf-8")

    const response = await request(`/api/git-status?cwd=${encodeURIComponent(join(root, "packages", "app"))}`)

    expect(response.status).toBe(200)
    expect(response.data.files).toEqual([
      { path: "nested.txt", indexStatus: "?", workTreeStatus: "?" },
    ])
  })

  it("returns a non-repository result without treating it as an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogpit-no-git-"))
    temporaryDirectories.push(root)

    const response = await request(`/api/git-status?cwd=${encodeURIComponent(root)}`)

    expect(response.status).toBe(200)
    expect(response.data).toEqual({ isRepository: false, files: [] })
  })
})
