// @vitest-environment node
import { mkdir, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  WORKSPACE_BUNDLE_REF_HEADER,
  WORKSPACE_UPLOAD_CHUNK_BYTES,
  WORKSPACE_UPLOAD_MAX_BYTES,
} from "../../../shared/contracts/workspaces"
import type { Middleware, UseFn } from "../../helpers"
import { registerWorkspaceRoutes } from "../../routes/workspaces"
import { createBundle, fetchBundle } from "../../workspaceTransfer/bundle"
import { snapshotWorkspace } from "../../workspaceTransfer/snapshot"
import { encodeEnvironment } from "../../workspaceTransfer/environment"
import { MAX_OPEN_UPLOADS, sweepExpiredTransfers } from "../../workspaceTransfer/transfers"
import { cleanupTempDirs, commitAll, gitOut, makeRepo, tempDir, writeFiles } from "../workspaceTransfer/gitFixtures"

const PREFIX = "/api/workspaces"
const originalEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, COGPIT_WORKSPACES_DIR: process.env.COGPIT_WORKSPACES_DIR }
let server: Server
let baseUrl: string
let scratch: string

function restoreEnv(name: keyof typeof originalEnv) {
  if (originalEnv[name] === undefined) delete process.env[name]
  else process.env[name] = originalEnv[name]
}

beforeAll(async () => {
  let handler: Middleware | undefined
  const use: UseFn = (path, candidate) => {
    if (path === PREFIX) handler = candidate
  }
  registerWorkspaceRoutes(use)
  if (!handler) throw new Error("workspaces route was not registered")
  const route = handler
  // Mounted like Connect does: the handler sees the path below its prefix.
  server = createServer((req, res) => {
    req.url = req.url!.slice(PREFIX.length) || "/"
    void route(req, res, () => {
      res.statusCode = 404
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${PREFIX}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(async () => {
  scratch = await tempDir("cogpit-workspace-routes-")
  process.env.TMPDIR = join(scratch, "tmp")
  process.env.TEMP = process.env.TMPDIR
  process.env.TMP = process.env.TMPDIR
  await mkdir(process.env.TMPDIR)
  process.env.COGPIT_WORKSPACES_DIR = join(scratch, "workspaces")
})

afterEach(async () => {
  restoreEnv("TMPDIR")
  restoreEnv("TEMP")
  restoreEnv("TMP")
  restoreEnv("COGPIT_WORKSPACES_DIR")
  await cleanupTempDirs()
})

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: response.status, data: await response.json() as Record<string, unknown> }
}

async function put(uploadId: string, offset: number | string, body: Uint8Array) {
  const response = await fetch(`${baseUrl}/uploads/${uploadId}?offset=${offset}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  })
  return { status: response.status, data: await response.json() as Record<string, unknown> }
}

async function newUpload(): Promise<string> {
  const { status, data } = await post("/uploads", {})
  expect(status).toBe(200)
  expect(data.uploadId).toMatch(/^[0-9a-f]{32}$/)
  return data.uploadId as string
}

function uploadFile(uploadId: string): string {
  return join(scratch, "tmp", "cogpit-workspace-uploads", `${uploadId}.bundle`)
}

describe("workspace upload chunks", () => {
  it("stages uploads owner-only and deletes secret uploads after failed import without echoing bytes", async () => {
    const repo = await makeRepo({ ".gitignore": ".env*\n", "app.ts": "v1" })
    const snapshot = await snapshotWorkspace(repo)
    const uploadId = await newUpload()
    if (process.platform !== "win32") expect((await stat(uploadFile(uploadId))).mode & 0o777).toBe(0o600)
    const secret = "SENTINEL_NEVER_IN_RESPONSE"
    await put(uploadId, 0, encodeEnvironment([{ path: ".env", bytes: Buffer.from(secret) }]))
    const imported = await post("/import", { repoKey: snapshot.repoKey, snapshot: "f".repeat(40), task: "broken", subdir: "", identity: snapshot.identity, targetCheckout: repo, environmentMode: "caller", environmentUploadId: uploadId })
    expect(imported.status).toBe(409)
    expect(JSON.stringify(imported)).not.toContain(secret)
    await expect(stat(uploadFile(uploadId))).rejects.toThrow()
  })
  it("appends at the current size, accepts retries, and reports mismatches with the stored size", async () => {
    const uploadId = await newUpload()
    const bytes = Buffer.from("0123456789")

    expect(await put(uploadId, 0, bytes.subarray(0, 4))).toEqual({ status: 200, data: { size: 4 } })
    expect(await put(uploadId, 0, bytes.subarray(0, 4))).toEqual({ status: 200, data: { size: 4 } })
    expect(await put(uploadId, 2, bytes.subarray(2, 4))).toEqual({ status: 200, data: { size: 4 } })
    expect(await put(uploadId, 2, bytes.subarray(2, 8))).toEqual({ status: 409, data: { size: 4 } })
    expect(await put(uploadId, 6, bytes.subarray(6))).toEqual({ status: 409, data: { size: 4 } })
    expect(await put(uploadId, 4, bytes.subarray(4))).toEqual({ status: 200, data: { size: 10 } })
    expect((await stat(uploadFile(uploadId))).size).toBe(10)
  })

  it("rejects bad ids, offsets and oversized chunks", async () => {
    const uploadId = await newUpload()

    expect((await put("not-an-id", 0, Buffer.from("x"))).status).toBe(400)
    expect((await put("0".repeat(32), 0, Buffer.from("x"))).status).toBe(404)
    expect((await put(uploadId, -1, Buffer.from("x"))).status).toBe(400)
    expect((await put(uploadId, "1e3", Buffer.from("x"))).status).toBe(400)
    const oversized = await fetch(`${baseUrl}/uploads/${uploadId}?offset=0`, {
      method: "PUT",
      body: Buffer.alloc(WORKSPACE_UPLOAD_CHUNK_BYTES + 1),
    }).catch(() => null)
    // The server may answer 413 or drop the connection mid-body; either way nothing is stored.
    if (oversized) expect(oversized.status).toBe(413)
    expect((await stat(uploadFile(uploadId))).size).toBe(0)
  })

  it("caps an upload's total size", async () => {
    const uploadId = await newUpload()
    await truncate(uploadFile(uploadId), WORKSPACE_UPLOAD_MAX_BYTES - 1)

    expect(await put(uploadId, WORKSPACE_UPLOAD_MAX_BYTES - 1, Buffer.from("xy"))).toEqual({
      status: 413,
      data: { size: WORKSPACE_UPLOAD_MAX_BYTES - 1 },
    })
  })

  it("limits how many uploads may be open at once", async () => {
    for (let i = 0; i < MAX_OPEN_UPLOADS; i++) await newUpload()
    expect((await post("/uploads", {})).status).toBe(429)
  })

  it("holds the limit when uploads are opened at the same moment", async () => {
    const statuses = (await Promise.all(
      Array.from({ length: MAX_OPEN_UPLOADS + 6 }, () => post("/uploads", {})),
    )).map((response) => response.status)

    expect(statuses.filter((status) => status === 200)).toHaveLength(MAX_OPEN_UPLOADS)
    expect(statuses.filter((status) => status === 429)).toHaveLength(6)
  })

  it("expires uploads left idle for an hour", async () => {
    const uploadId = await newUpload()

    await sweepExpiredTransfers(Date.now() + 61 * 60_000)

    expect((await put(uploadId, 0, Buffer.from("x"))).status).toBe(404)
  })
})

describe("workspace transfer over HTTP", () => {
  it("imports an uploaded bundle, exports the device's work, and serves it once", async () => {
    const hub = await makeRepo({ "app/main.ts": "v1\n", "keep.txt": "keep\n" })
    await writeFiles(hub, { "app/main.ts": "v2\n" })
    const sent = await snapshotWorkspace(join(hub, "app"))

    expect(await post("/probe", { repoKey: sent.repoKey })).toEqual({ status: 200, data: { commits: [] } })

    const bundle = await createBundle(hub, sent.snapshot, [])
    const contents = await readFile(bundle!.path)
    await rm(bundle!.path)
    const uploadId = await newUpload()
    const half = Math.floor(contents.length / 2)
    expect((await put(uploadId, 0, contents.subarray(0, half))).status).toBe(200)
    expect(await put(uploadId, half, contents.subarray(half))).toEqual({ status: 200, data: { size: contents.length } })

    const imported = await post("/import", {
      repoKey: sent.repoKey,
      uploadId,
      bundleRef: bundle!.ref,
      snapshot: sent.snapshot,
      task: "http task",
      subdir: sent.subdir,
    })
    expect(imported.status).toBe(200)
    expect(imported.data).toMatchObject({
      workspaceId: `${sent.repoKey}/http-task`,
      cwd: join(scratch, "workspaces", sent.repoKey, "http-task", "app"),
      branch: "cogpit/http-task",
    })
    await expect(stat(uploadFile(uploadId))).rejects.toThrow()
    expect((await post("/probe", { repoKey: sent.repoKey })).data.commits).toContain(sent.snapshot)

    const worktree = imported.data.path as string
    await writeFiles(worktree, { "app/main.ts": "v3\n" })
    await commitAll(worktree, "device work")
    await writeFiles(worktree, { "app/extra.ts": "extra\n" })

    const exported = await post("/export", { workspaceId: imported.data.workspaceId, exclude: [sent.snapshot] })
    expect(exported.status).toBe(200)
    expect(exported.data).toMatchObject({ dirty: true, downloadId: expect.stringMatching(/^[0-9a-f]{32}$/) })

    const download = await fetch(`${baseUrl}/downloads/${exported.data.downloadId as string}`)
    expect(download.status).toBe(200)
    expect(download.headers.get("content-type")).toBe("application/octet-stream")
    const ref = download.headers.get(WORKSPACE_BUNDLE_REF_HEADER)!
    const received = join(scratch, "received.bundle")
    await writeFile(received, Buffer.from(await download.arrayBuffer()))
    await fetchBundle(hub, received, ref, "refs/heads/cogpit/dev/http-task")

    expect(await gitOut(hub, ["rev-parse", "cogpit/dev/http-task"])).toBe(exported.data.tip)
    expect(await gitOut(hub, ["diff", "--name-status", `${sent.snapshot}..cogpit/dev/http-task`])).toBe(
      "A\tapp/extra.ts\nM\tapp/main.ts",
    )
    await expect.poll(() => readdir(join(scratch, "tmp", "cogpit-workspace-downloads"))).toEqual([])
    expect((await fetch(`${baseUrl}/downloads/${exported.data.downloadId as string}`)).status).toBe(404)

    const settled = await commitAll(worktree, "finish")
    expect(await post("/export", { workspaceId: imported.data.workspaceId, exclude: [settled] })).toMatchObject({
      status: 200,
      data: { downloadId: null },
    })
  })

  it("validates request bodies", async () => {
    expect((await post("/probe", { repoKey: "../../etc" })).status).toBe(400)
    expect((await post("/import", { repoKey: "r-0123456789", uploadId: "0".repeat(32), snapshot: "a".repeat(40), task: "t", subdir: "" })).status).toBe(400)
    expect((await post("/import", { repoKey: "r-0123456789", uploadId: "0".repeat(32), bundleRef: "refs/x", snapshot: "a".repeat(40), task: "t", subdir: "" })).status).toBe(404)
    expect((await post("/export", { workspaceId: "r-0123456789/t", exclude: "nope" })).status).toBe(400)
    expect((await post("/export", { workspaceId: "../../x", exclude: [] })).status).toBe(400)
    expect((await fetch(`${baseUrl}/downloads/${"0".repeat(32)}`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/unknown`)).status).toBe(404)
  })
})
