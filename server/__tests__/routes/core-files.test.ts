// @vitest-environment node
import { execFile as execFileCallback } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import express from "express"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { startCore, type CoreLease } from "../../core/supervisor"
import { bodySizeLimit } from "../../security"
import {
  registerFileContentRoutes,
  registerGitDiffRoutes,
  registerGitStatusRoutes,
  registerLocalFileRoutes,
  registerProjectFileContentRoutes,
  registerProjectFileRoutes,
} from "../../routes/core-files"

/**
 * The files and git routes forwarded to the real core binary, held to the
 * status codes, headers and bodies the TypeScript routes answered with.
 */

const execFile = promisify(execFileCallback)
const posixOnly = process.platform === "win32" ? it.skip : it
const temporaryDirectories: string[] = []

let core: CoreLease
let server: Server
let origin: string

beforeAll(async () => {
  core = await startCore({ dataDir: tmpdir() })
  const app = express()
  app.use(bodySizeLimit)
  for (const register of [
    registerLocalFileRoutes,
    registerFileContentRoutes,
    registerProjectFileRoutes,
    registerProjectFileContentRoutes,
    registerGitStatusRoutes,
    registerGitDiffRoutes,
  ]) {
    register((path, handler) => app.use(path, handler))
  }
  app.use("/api", (_req, res) => void res.status(404).json({ error: "Not found" }))
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 30_000)

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await core.release()
})

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

function url(route: string, params: Record<string, string> = {}): string {
  const query = new URLSearchParams(params).toString()
  return `${origin}${route}${query ? `?${query}` : ""}`
}

async function getJson(route: string, params: Record<string, string>) {
  const response = await fetch(url(route, params))
  return { status: response.status, contentType: response.headers.get("content-type"), data: await response.json() as any }
}

async function putJson(body: unknown) {
  const response = await fetch(url("/api/project-file"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  return { status: response.status, data: await response.json() as Record<string, unknown> }
}

async function git(cwd: string, ...args: string[]) {
  await execFile("git", ["-c", "user.name=Cogpit Test", "-c", "user.email=test@example.com", ...args], { cwd })
}

async function repository(): Promise<string> {
  const root = await temporaryDirectory("cogpit-core-files-git-")
  await git(root, "init", "-q", "-b", "main")
  return root
}

async function commitAll(root: string) {
  await git(root, "add", "-A")
  await git(root, "commit", "-q", "-m", "initial")
}

describe("local-file through core", () => {
  it("streams media with the TypeScript route's headers", async () => {
    const directory = await temporaryDirectory("cogpit-core-files-media-")
    const image = join(directory, "image.png")
    await writeFile(image, "image")

    const response = await fetch(url("/api/local-file", { path: image }))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(response.headers.get("content-length")).toBe("5")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600")
    expect(await response.text()).toBe("image")
  })

  it("serves byte ranges so videos seek, and refuses ranges past the end", async () => {
    const directory = await temporaryDirectory("cogpit-core-files-video-")
    const video = join(directory, "recording.webm")
    await writeFile(video, "video")

    const part = await fetch(url("/api/local-file", { path: video }), { headers: { range: "bytes=2-3" } })
    expect(part.status).toBe(206)
    expect(part.headers.get("content-type")).toBe("video/webm")
    expect(part.headers.get("content-range")).toBe("bytes 2-3/5")
    expect(part.headers.get("content-length")).toBe("2")
    expect(await part.text()).toBe("de")

    const suffix = await fetch(url("/api/local-file", { path: video }), { headers: { range: "bytes=-2" } })
    expect(suffix.headers.get("content-range")).toBe("bytes 3-4/5")
    expect(await suffix.text()).toBe("eo")

    const past = await fetch(url("/api/local-file", { path: video }), { headers: { range: "bytes=9-12" } })
    expect(past.status).toBe(416)
    expect(past.headers.get("content-range")).toBe("bytes */5")
    expect(await past.json()).toEqual({ error: "Range not satisfiable" })
  })

  it("allows large videos and refuses non-media, missing and relative paths", async () => {
    const directory = await temporaryDirectory("cogpit-core-files-refuse-")
    const video = join(directory, "large.mp4")
    await writeFile(video, "")
    await truncate(video, 200 * 1024 * 1024)
    await writeFile(join(directory, "notes.txt"), "secret")

    const large = await fetch(url("/api/local-file", { path: video }), { headers: { range: "bytes=0-0" } })
    expect(large.status).toBe(206)
    await large.arrayBuffer()
    expect(await getJson("/api/local-file", { path: join(directory, "notes.txt") }))
      .toMatchObject({ status: 403, contentType: "application/json", data: { error: "Only image and video files are allowed" } })
    expect(await getJson("/api/local-file", { path: join(directory, "gone.png") }))
      .toMatchObject({ status: 404, data: { error: "File not found" } })
    expect(await getJson("/api/local-file", { path: "relative.png" }))
      .toMatchObject({ status: 400, data: { error: "path must be absolute" } })
    expect(await getJson("/api/local-file", {}))
      .toMatchObject({ status: 400, data: { error: "path query parameter required" } })
  })

  it("leaves methods it does not serve to the next handler", async () => {
    const response = await fetch(url("/api/local-file", { path: "/tmp/x.png" }), { method: "POST" })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "Not found" })
  })
})

describe("file-content through core", () => {
  it("returns text with non-cacheable headers", async () => {
    const directory = await temporaryDirectory("cogpit-core-files-text-")
    const notes = join(directory, "notes.txt")
    await writeFile(notes, "hello")

    const response = await fetch(url("/api/file-content", { path: notes }))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-cache")
    expect(await response.text()).toBe("hello")
  })
})

describe("project-files through core", () => {
  it("lists git-aware files, counts every match and caches until refresh", async () => {
    const root = await repository()
    await writeFile(join(root, ".gitignore"), "ignored.log\n")
    await writeFile(join(root, "ignored.log"), "noise\n")
    for (let index = 0; index < 3; index += 1) await writeFile(join(root, `widget-${index}.ts`), "")

    expect(await getJson("/api/project-files", { cwd: root, limit: "100" })).toEqual({
      status: 200,
      contentType: "application/json",
      data: { files: [".gitignore", "widget-0.ts", "widget-1.ts", "widget-2.ts"], totalMatches: 4, scanLimited: false },
    })
    expect((await getJson("/api/project-files", { cwd: root, q: "widget", limit: "2" })).data)
      .toEqual({ files: ["widget-0.ts", "widget-1.ts"], totalMatches: 3, scanLimited: false })

    await writeFile(join(root, "widget-3.ts"), "")
    expect((await getJson("/api/project-files", { cwd: root, q: "widget" })).data.totalMatches).toBe(3)
    expect((await getJson("/api/project-files", { cwd: root, q: "widget", refresh: "1" })).data.totalMatches).toBe(4)
  })

  it("lists one tree directory at a time and refuses escapes", async () => {
    const root = await temporaryDirectory("cogpit-core-files-tree-")
    await mkdir(join(root, "src", "lib"), { recursive: true })
    await writeFile(join(root, "src", "lib", "util.ts"), "")
    await writeFile(join(root, "src", "main.ts"), "")
    await writeFile(join(root, "README.md"), "")

    expect((await getJson("/api/project-files/tree", { cwd: root })).data).toEqual({
      entries: [{ name: "src", type: "directory" }, { name: "README.md", type: "file" }],
      scanLimited: false,
    })
    expect((await getJson("/api/project-files/tree", { cwd: root, dir: "src" })).data.entries)
      .toEqual([{ name: "lib", type: "directory" }, { name: "main.ts", type: "file" }])
    expect(await getJson("/api/project-files/tree", { cwd: root, dir: "../outside" }))
      .toMatchObject({ status: 400, data: { error: "dir must stay inside the project" } })
  })
})

describe("project-file through core", () => {
  async function project() {
    const root = await temporaryDirectory("cogpit-core-files-project-")
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "app.ts"), "export const value = 1\n")
    return root
  }

  it("reads and saves with optimistic concurrency", async () => {
    const root = await project()
    const read = await getJson("/api/project-file", { cwd: root, path: "src/app.ts" })
    expect(read).toMatchObject({ status: 200, data: { content: "export const value = 1\n", size: 23 } })

    const save = await putJson({ cwd: root, path: "src/app.ts", content: "export const value = 2\n", expectedMtimeMs: read.data.mtimeMs })

    expect(save).toMatchObject({ status: 200, data: { ok: true, size: 23 } })
    expect(await readFile(join(root, "src", "app.ts"), "utf-8")).toBe("export const value = 2\n")
  })

  it("returns a conflict instead of overwriting a file changed on disk", async () => {
    const root = await project()
    const read = await getJson("/api/project-file", { cwd: root, path: "src/app.ts" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(join(root, "src", "app.ts"), "external change\n")

    const save = await putJson({ cwd: root, path: "src/app.ts", content: "stale edit\n", expectedMtimeMs: read.data.mtimeMs })

    expect(save).toEqual({ status: 409, data: { error: "File changed on disk. Reload it before saving." } })
    expect(await readFile(join(root, "src", "app.ts"), "utf-8")).toBe("external change\n")
  })

  it("rejects traversal and invalid save bodies", async () => {
    const root = await project()
    expect(await getJson("/api/project-file", { cwd: root, path: "../secret.txt" }))
      .toMatchObject({ status: 403, data: { error: "File is outside the project" } })
    expect(await putJson({ cwd: root, path: "src/app.ts" }))
      .toEqual({ status: 400, data: { error: "cwd, path, content, and expectedMtimeMs are required" } })
    expect(await putJson("{not json")).toEqual({ status: 500, data: { error: "Unable to access project file" } })
  })

  posixOnly("rejects a symlink that escapes the project", async () => {
    const root = await project()
    const outside = await temporaryDirectory("cogpit-core-files-outside-")
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(join(outside, "secret.txt"), join(root, "src", "escape.txt"))

    expect((await getJson("/api/project-file", { cwd: root, path: "src/escape.txt" })).status).toBe(403)
  })
})

describe("git status and diff through core", { timeout: process.platform === "win32" ? 20_000 : 5_000 }, () => {
  it("reports the branch and changed files relative to the cwd", async () => {
    const root = await repository()
    await mkdir(join(root, "packages", "app"), { recursive: true })
    await writeFile(join(root, "tracked.txt"), "one\n")
    await writeFile(join(root, "packages", "app", "nested.txt"), "one\n")
    await commitAll(root)
    await writeFile(join(root, "tracked.txt"), "two\n")
    await writeFile(join(root, "packages", "app", "nested.txt"), "two\n")

    expect(await getJson("/api/git-status", { cwd: root })).toEqual({
      status: 200,
      contentType: "application/json",
      data: {
        isRepository: true,
        root,
        branch: "main",
        upstream: null,
        ahead: 0,
        behind: 0,
        detached: false,
        files: [
          { path: "packages/app/nested.txt", indexStatus: " ", workTreeStatus: "M" },
          { path: "tracked.txt", indexStatus: " ", workTreeStatus: "M" },
        ],
      },
    })
    expect((await getJson("/api/git-status", { cwd: join(root, "packages", "app") })).data.files)
      .toEqual([{ path: "nested.txt", indexStatus: " ", workTreeStatus: "M" }])
  })

  it("reports a directory outside git without an error", async () => {
    const root = await temporaryDirectory("cogpit-core-files-plain-")
    expect(await getJson("/api/git-status", { cwd: root })).toMatchObject({ status: 200, data: { isRepository: false, files: [] } })
    expect(await getJson("/api/git-diff", { cwd: root, path: "a.txt" }))
      .toMatchObject({ status: 400, data: { error: "Not a git repository" } })
  })

  it("returns committed and working-tree contents, renames and binary flags", async () => {
    const root = await repository()
    await writeFile(join(root, "tracked.txt"), "one\ntwo\n")
    await writeFile(join(root, "old.txt"), "moved\n")
    await writeFile(join(root, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    await commitAll(root)
    await writeFile(join(root, "tracked.txt"), "one\nthree\n")
    await git(root, "mv", "old.txt", "new.txt")

    expect((await getJson("/api/git-diff", { cwd: root, path: "tracked.txt" })).data).toEqual({
      path: "tracked.txt",
      original: "one\ntwo\n",
      current: "one\nthree\n",
      binary: false,
      tooLarge: false,
    })
    expect((await getJson("/api/git-diff", { cwd: root, path: "new.txt", originalPath: "old.txt" })).data)
      .toMatchObject({ original: "moved\n", current: "moved\n" })
    expect((await getJson("/api/git-diff", { cwd: root, path: "logo.bin" })).data)
      .toMatchObject({ binary: true, original: null, current: null })
    expect(await getJson("/api/git-diff", { cwd: root, path: "../escape.txt" }))
      .toEqual({ status: 403, contentType: "application/json", data: { error: "File is outside the project" } })
  })
})
