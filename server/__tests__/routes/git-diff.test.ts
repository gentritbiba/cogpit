// @vitest-environment node
import { execFile as execFileCallback } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import { registerGitDiffRoutes } from "../../routes/git-diff"

const execFile = promisify(execFileCallback)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function getHandler(): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (path, candidate) => {
    if (path === "/api/git-diff") handler = candidate
  }
  registerGitDiffRoutes(use)
  if (!handler) throw new Error("Git diff route was not registered")
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

async function createRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cogpit-git-diff-"))
  temporaryDirectories.push(root)
  await execFile("git", ["init", "-b", "main"], { cwd: root })
  return root
}

async function commitAll(root: string, message: string) {
  await execFile("git", ["add", "-A"], { cwd: root })
  await execFile(
    "git",
    ["-c", "user.name=Cogpit Test", "-c", "user.email=test@example.com", "commit", "-m", message],
    { cwd: root },
  )
}

function diffUrl(cwd: string, path: string, originalPath?: string) {
  const original = originalPath ? `&originalPath=${encodeURIComponent(originalPath)}` : ""
  return `/api/git-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}${original}`
}

describe("git diff route", () => {
  it("returns committed and working-tree content for a modified file", async () => {
    const root = await createRepository()
    await writeFile(join(root, "tracked.txt"), "one\ntwo\n", "utf-8")
    await commitAll(root, "initial")
    await writeFile(join(root, "tracked.txt"), "one\nthree\n", "utf-8")

    const response = await request(diffUrl(root, "tracked.txt"))

    expect(response.status).toBe(200)
    expect(response.data).toEqual({
      path: "tracked.txt",
      original: "one\ntwo\n",
      current: "one\nthree\n",
      binary: false,
      tooLarge: false,
    })
  })

  it("reports an untracked file as absent from the last commit", async () => {
    const root = await createRepository()
    await writeFile(join(root, "tracked.txt"), "one\n", "utf-8")
    await commitAll(root, "initial")
    await writeFile(join(root, "new.txt"), "fresh\n", "utf-8")

    const response = await request(diffUrl(root, "new.txt"))

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ original: null, current: "fresh\n" })
  })

  it("reports a deleted file as absent from the working tree", async () => {
    const root = await createRepository()
    await writeFile(join(root, "gone.txt"), "bye\n", "utf-8")
    await commitAll(root, "initial")
    await rm(join(root, "gone.txt"))

    const response = await request(diffUrl(root, "gone.txt"))

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ original: "bye\n", current: null })
  })

  it("reads the committed side of a rename from its original path", async () => {
    const root = await createRepository()
    await writeFile(join(root, "old.txt"), "moved\n", "utf-8")
    await commitAll(root, "initial")
    await execFile("git", ["mv", "old.txt", "new.txt"], { cwd: root })

    const response = await request(diffUrl(root, "new.txt", "old.txt"))

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ original: "moved\n", current: "moved\n" })
  })

  it("resolves paths relative to a subdirectory cwd", async () => {
    const root = await createRepository()
    await execFile("git", ["init", "-b", "main"], { cwd: root })
    const nested = join(root, "packages", "app")
    await execFile("mkdir", ["-p", nested])
    await writeFile(join(nested, "nested.txt"), "one\n", "utf-8")
    await commitAll(root, "initial")
    await writeFile(join(nested, "nested.txt"), "two\n", "utf-8")

    const response = await request(diffUrl(nested, "nested.txt"))

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ original: "one\n", current: "two\n" })
  })

  it("flags binary files instead of returning their bytes", async () => {
    const root = await createRepository()
    await writeFile(join(root, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
    await commitAll(root, "initial")
    await writeFile(join(root, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x03, 0x04]))

    const response = await request(diffUrl(root, "logo.bin"))

    expect(response.status).toBe(200)
    expect(response.data).toMatchObject({ binary: true, original: null, current: null })
  })

  it("rejects paths outside the project", async () => {
    const root = await createRepository()
    await writeFile(join(root, "tracked.txt"), "one\n", "utf-8")
    await commitAll(root, "initial")

    const response = await request(diffUrl(root, "../escape.txt"))

    expect(response.status).toBe(403)
    expect(response.data).toEqual({ error: "File is outside the project" })
  })

  it("refuses to diff outside a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "cogpit-no-git-diff-"))
    temporaryDirectories.push(root)
    await writeFile(join(root, "loose.txt"), "one\n", "utf-8")

    const response = await request(diffUrl(root, "loose.txt"))

    expect(response.status).toBe(400)
    expect(response.data).toEqual({ error: "Not a git repository" })
  })
})
