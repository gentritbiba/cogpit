// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { access, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const { mayActHostWide, reportAuthEvent } = vi.hoisted(() => ({ mayActHostWide: vi.fn(() => true), reportAuthEvent: vi.fn() }))
vi.mock("../../edition", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../edition")>(),
  mayActHostWide,
  reportAuthEvent,
}))

import { registerFolderRoutes } from "../../routes/folders"

let server: Server
let base: string
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-folder-routes-"))
  process.env.COGPIT_PROJECTS_ROOT = root
  reportAuthEvent.mockReset()
  mayActHostWide.mockReturnValue(true)
  registerFolderRoutes((_path, handler) => {
    server = createServer((req, res) => {
      // Express strips the mount path; this stand-in serves nothing else.
      req.url = (req.url ?? "/").replace(/^\/api\/folders/, "") || "/"
      void handler(req, res, () => {
        res.statusCode = 404
        res.end("unserved")
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Server has no port")
  base = `http://127.0.0.1:${address.port}/api/folders`
})

afterEach(async () => {
  delete process.env.COGPIT_PROJECTS_ROOT
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})

async function list(path?: string) {
  const response = await fetch(path === undefined ? base : `${base}?path=${encodeURIComponent(path)}`)
  return { status: response.status, body: await response.json() }
}

async function create(body: unknown) {
  const response = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

describe("GET /api/folders", () => {
  it("lists the projects root when no path is given", async () => {
    await mkdir(join(root, "app"))

    expect(await list()).toEqual({
      status: 200,
      body: {
        path: root,
        parent: dirname(root),
        root,
        confined: false,
        folders: [{ name: "app", path: join(root, "app") }],
        truncated: false,
      },
    })
  })

  it("lists the folder a path names", async () => {
    await mkdir(join(root, "app", "src"), { recursive: true })
    const { status, body } = await list(join(root, "app"))
    expect(status).toBe(200)
    expect(body).toMatchObject({ path: join(root, "app"), parent: root, root, folders: [{ name: "src" }] })
  })

  it.each([
    ["a relative path", "app"],
    ["a path holding NUL", `${join(tmpdir(), "a")}\0`],
  ])("answers 400 for %s", async (_label, path) => {
    expect(await list(path)).toEqual({ status: 400, body: { error: "path must be an absolute path", code: "INVALID_REQUEST" } })
  })

  it("answers 404 for a folder that does not exist", async () => {
    const missing = join(root, "missing")
    expect(await list(missing)).toEqual({ status: 404, body: { error: `The folder ${missing} does not exist`, code: "NOT_FOUND" } })
  })
})

describe("POST /api/folders", () => {
  it("makes the folder, answers its path and records it", async () => {
    const path = join(root, "new-project")

    expect(await create({ parent: root, name: "new-project" })).toEqual({ status: 201, body: { path } })
    await expect(access(path)).resolves.toBeUndefined()
    expect(reportAuthEvent).toHaveBeenCalledWith(expect.anything(), "folder.create", { path })
  })

  it("answers 409 for a name already taken, recording nothing", async () => {
    await mkdir(join(root, "taken"))
    expect(await create({ parent: root, name: "taken" })).toEqual({
      status: 409, body: { error: `taken already exists in ${root}`, code: "CONFLICT" },
    })
    expect(reportAuthEvent).not.toHaveBeenCalled()
  })

  it("refuses a name that reaches outside the parent", async () => {
    const { status } = await create({ parent: root, name: "../escaped" })
    expect(status).toBe(400)
    expect(await readdir(dirname(root))).not.toContain("escaped")
    expect(reportAuthEvent).not.toHaveBeenCalled()
  })

  it.each([
    ["no name", { parent: "/" }, "name must be a string"],
    ["a relative parent", { parent: "code", name: "x" }, "parent must be an absolute path"],
    ["no parent", { name: "x" }, "parent must be an absolute path"],
    ["a body that is not an object", [], "name must be a string"],
  ])("answers 400 for %s", async (_label, body, error) => {
    expect(await create(body)).toEqual({ status: 400, body: { error, code: "INVALID_REQUEST" } })
  })

  it("answers 400 for a body that is not JSON", async () => {
    expect((await create("{not json")).status).toBe(400)
  })
})

describe("a caller who may not act host-wide", () => {
  beforeEach(() => {
    mayActHostWide.mockReturnValue(false)
  })

  it("starts at the projects root and goes no higher", async () => {
    await mkdir(join(root, "app"))

    expect((await list()).body).toMatchObject({ path: root, parent: null, root, confined: true })
    expect((await list(join(root, "app"))).body).toMatchObject({ parent: root, confined: true })
  })

  it("is refused a folder above the projects root", async () => {
    expect(await list(dirname(root))).toEqual({
      status: 403, body: { error: `Only folders inside ${root} are open to you`, code: "FORBIDDEN" },
    })
  })

  it("is refused a link inside the projects root that leads out of it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "cogpit-folder-outside-"))
    try {
      await symlink(outside, join(root, "out"))
      expect((await list(join(root, "out"))).status).toBe(403)
      expect((await create({ parent: join(root, "out"), name: "x" })).status).toBe(403)
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("makes folders only inside the projects root", async () => {
    expect((await create({ parent: root, name: "mine" })).status).toBe(201)
    expect((await create({ parent: dirname(root), name: "escaped-root" })).status).toBe(403)
    expect(await readdir(dirname(root))).not.toContain("escaped-root")
    expect(reportAuthEvent).toHaveBeenCalledOnce()
  })
})

describe("what the route leaves to others", () => {
  it.each([
    ["a sub-path", "GET", "/child"],
    ["another method", "PUT", ""],
  ])("passes on %s", async (_label, method, suffix) => {
    const response = await fetch(`${base}${suffix}`, { method })
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("unserved")
  })
})
