// @vitest-environment node
import { EventEmitter } from "node:events"
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import { registerProjectFileContentRoutes } from "../../routes/project-file"

const temporaryDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function getHandler(): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (path, candidate) => {
    if (path === "/api/project-file") handler = candidate
  }
  registerProjectFileContentRoutes(use)
  if (!handler) throw new Error("Project file route was not registered")
  return handler
}

function createHarness(method: string, url: string, body?: unknown) {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string }
  req.method = method
  req.url = url
  let responseBody = ""
  const res = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { responseBody = value ?? "" }),
  }
  const next = vi.fn()
  const run = async () => {
    const pending = getHandler()(req as never, res as never, next)
    if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)))
    req.emit("end")
    await pending
    return {
      status: res.statusCode,
      data: responseBody ? JSON.parse(responseBody) as Record<string, unknown> : null,
      next,
    }
  }
  return { run }
}

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), "cogpit-project-file-"))
  temporaryDirectories.push(root)
  await mkdir(join(root, "src"))
  await writeFile(join(root, "src", "app.ts"), "export const value = 1\n", "utf-8")
  return root
}

describe("project file content route", () => {
  it("reads and saves a UTF-8 project file with optimistic concurrency", async () => {
    const root = await createProject()
    const params = `cwd=${encodeURIComponent(root)}&path=${encodeURIComponent("src/app.ts")}`
    const read = await createHarness("GET", `/api/project-file?${params}`).run()

    expect(read.status).toBe(200)
    expect(read.data?.content).toBe("export const value = 1\n")

    const save = await createHarness("PUT", "/api/project-file", {
      cwd: root,
      path: "src/app.ts",
      content: "export const value = 2\n",
      expectedMtimeMs: read.data?.mtimeMs,
    }).run()

    expect(save.status).toBe(200)
    expect(await readFile(join(root, "src", "app.ts"), "utf-8")).toBe("export const value = 2\n")
  })

  it("rejects traversal and symlinks that escape the project", async () => {
    const root = await createProject()
    const outside = await mkdtemp(join(tmpdir(), "cogpit-project-file-outside-"))
    temporaryDirectories.push(outside)
    await writeFile(join(outside, "secret.txt"), "secret", "utf-8")
    await symlink(join(outside, "secret.txt"), join(root, "src", "escape.txt"))

    const traversal = await createHarness(
      "GET",
      `/api/project-file?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent("../secret.txt")}`,
    ).run()
    const symlinkEscape = await createHarness(
      "GET",
      `/api/project-file?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent("src/escape.txt")}`,
    ).run()

    expect(traversal.status).toBe(403)
    expect(symlinkEscape.status).toBe(403)
  })

  it("returns a conflict instead of overwriting a file changed on disk", async () => {
    const root = await createProject()
    const path = join(root, "src", "app.ts")
    const read = await createHarness(
      "GET",
      `/api/project-file?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent("src/app.ts")}`,
    ).run()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(path, "external change\n", "utf-8")

    const save = await createHarness("PUT", "/api/project-file", {
      cwd: root,
      path: "src/app.ts",
      content: "stale edit\n",
      expectedMtimeMs: read.data?.mtimeMs,
    }).run()

    expect(save.status).toBe(409)
    expect(await readFile(path, "utf-8")).toBe("external change\n")
  })
})
