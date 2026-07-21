// @vitest-environment node

import { EventEmitter } from "node:events"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Middleware, UseFn } from "../../../http"
import { registerConfigBrowserRoutes } from "../../../routes/config-browser"

interface RouteResponse {
  status: number
  body: Record<string, unknown>
}

async function invoke(
  handler: Middleware,
  method: string,
  url: string,
  body?: unknown,
): Promise<RouteResponse> {
  const req = Object.assign(new EventEmitter(), {
    method,
    url,
    headers: {},
  })
  let statusCode = 200
  let responseBody = ""
  const res = {
    get statusCode() { return statusCode },
    set statusCode(value: number) { statusCode = value },
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { responseBody = value ?? "" }),
  }
  const next = vi.fn()

  const pending = handler(req as never, res as never, next)
  if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)))
  req.emit("end")
  await pending
  await vi.waitFor(() => {
    expect(res.end.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0)
  })

  return {
    status: statusCode,
    body: responseBody ? JSON.parse(responseBody) as Record<string, unknown> : {},
  }
}

describe("config-browser routes", () => {
  let fixtureRoot: string
  let projectDir: string
  let claudeDir: string
  let agentsDir: string
  let outsideDir: string
  let handlers: Map<string, Middleware>

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "cogpit-config-routes-"))
    projectDir = join(fixtureRoot, "project")
    claudeDir = join(projectDir, ".claude")
    agentsDir = join(claudeDir, "agents")
    outsideDir = join(fixtureRoot, "outside")
    await Promise.all([
      mkdir(agentsDir, { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
    ])

    handlers = new Map()
    const use: UseFn = (path, handler) => { handlers.set(path, handler) }
    registerConfigBrowserRoutes(use)
  })

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true })
  })

  function route(path: string): Middleware {
    const handler = handlers.get(path)
    if (!handler) throw new Error(`Route was not registered: ${path}`)
    return handler
  }

  it("creates and updates normal files inside .claude", async () => {
    const created = await invoke(
      route("/api/config-browser/create"),
      "POST",
      "/api/config-browser/create",
      { dir: agentsDir, fileType: "agent", name: "reviewer" },
    )
    const agentPath = join(agentsDir, "reviewer.md")

    expect(created.status).toBe(200)
    expect(created.body.path).toBe(agentPath)
    expect(await readFile(agentPath, "utf-8")).toContain("name: reviewer")

    const updated = await invoke(
      route("/api/config-browser/file"),
      "POST",
      "/api/config-browser/file",
      { path: agentPath, content: "updated agent\n" },
    )

    expect(updated.status).toBe(200)
    expect(await readFile(agentPath, "utf-8")).toBe("updated agent\n")
  })

  it("reads and updates a project-root CLAUDE.md", async () => {
    const instructionsPath = join(projectDir, "CLAUDE.md")
    await writeFile(instructionsPath, "before\n", "utf-8")

    const read = await invoke(
      route("/api/config-browser/file"),
      "GET",
      `/api/config-browser/file?path=${encodeURIComponent(instructionsPath)}`,
    )
    const updated = await invoke(
      route("/api/config-browser/file"),
      "POST",
      "/api/config-browser/file",
      { path: instructionsPath, content: "after\n" },
    )

    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ path: instructionsPath, content: "before\n" })
    expect(updated.status).toBe(200)
    expect(await readFile(instructionsPath, "utf-8")).toBe("after\n")
  })

  it.each([
    "..",
    "../escape",
    "nested/escape",
    "/absolute",
    "C:\\absolute",
    "\\\\server\\share",
  ])("rejects unsafe create name %j", async (name) => {
    const response = await invoke(
      route("/api/config-browser/create"),
      "POST",
      "/api/config-browser/create",
      { dir: agentsDir, fileType: "agent", name },
    )

    expect(response.status).toBe(400)
    expect(response.body.error).toBe("Invalid name")
  })

  it("rejects create through a directory symlink that escapes .claude", async () => {
    const linkedDirectory = join(claudeDir, "linked-agents")
    const escapedFile = join(outsideDir, "escaped.md")
    await symlink(outsideDir, linkedDirectory, process.platform === "win32" ? "junction" : undefined)

    const response = await invoke(
      route("/api/config-browser/create"),
      "POST",
      "/api/config-browser/create",
      { dir: linkedDirectory, fileType: "agent", name: "escaped" },
    )

    expect(response.status).toBe(403)
    await expect(access(escapedFile)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects reading or updating a file symlink that escapes .claude", async () => {
    const outsideFile = join(outsideDir, "secret.md")
    const linkedFile = join(agentsDir, "linked.md")
    await writeFile(outsideFile, "secret\n", "utf-8")
    await symlink(outsideFile, linkedFile, process.platform === "win32" ? "file" : undefined)

    const read = await invoke(
      route("/api/config-browser/file"),
      "GET",
      `/api/config-browser/file?path=${encodeURIComponent(linkedFile)}`,
    )
    const update = await invoke(
      route("/api/config-browser/file"),
      "POST",
      "/api/config-browser/file",
      { path: linkedFile, content: "overwritten\n" },
    )

    expect(read.status).toBe(403)
    expect(update.status).toBe(403)
    expect(await readFile(outsideFile, "utf-8")).toBe("secret\n")
  })

  it("rejects traversal rename destinations and still supports a normal rename", async () => {
    const originalPath = join(agentsDir, "original.md")
    await writeFile(originalPath, "agent\n", "utf-8")

    for (const newName of ["../escaped", "/absolute", "C:\\absolute"]) {
      const rejected = await invoke(
        route("/api/config-browser/rename"),
        "POST",
        "/api/config-browser/rename",
        { oldPath: originalPath, newName },
      )
      expect(rejected.status).toBe(400)
    }

    const renamed = await invoke(
      route("/api/config-browser/rename"),
      "POST",
      "/api/config-browser/rename",
      { oldPath: originalPath, newName: "renamed" },
    )
    const renamedPath = join(agentsDir, "renamed.md")

    expect(renamed.status).toBe(200)
    expect(renamed.body.newPath).toBe(renamedPath)
    expect(await readFile(renamedPath, "utf-8")).toBe("agent\n")
    await expect(access(originalPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps plugin-cache files read-only across update and delete routes", async () => {
    const cachedDirectory = join(claudeDir, "plugins", "cache", "plugin")
    const cachedFile = join(cachedDirectory, "SKILL.md")
    await mkdir(cachedDirectory, { recursive: true })
    await writeFile(cachedFile, "cached\n", "utf-8")

    const update = await invoke(
      route("/api/config-browser/file"),
      "POST",
      "/api/config-browser/file",
      { path: cachedFile, content: "overwritten\n" },
    )
    const deletion = await invoke(
      route("/api/config-browser/file"),
      "DELETE",
      `/api/config-browser/file?path=${encodeURIComponent(cachedFile)}`,
    )

    expect(update.status).toBe(403)
    expect(deletion.status).toBe(403)
    expect(await readFile(cachedFile, "utf-8")).toBe("cached\n")
  })
})
