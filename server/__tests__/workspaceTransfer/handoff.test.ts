// @vitest-environment node
import { mkdir, readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import { addDevice, initDeviceRegistry, type HubDevice } from "../../hub/registry"
import { registerWorkspaceRoutes } from "../../routes/workspaces"
import { discardWorkspace, fetchWorkspaceBack, handoffBriefing, sendWorkspace } from "../../workspaceTransfer/handoff"
import { cleanupTempDirs, commitAll, gitOut, makeRepo, tempDir, writeFiles } from "./gitFixtures"

/**
 * A task handed to another machine and back, over HTTP against the real
 * device routes, with real git on both sides.
 */

const PREFIX = "/api/workspaces"
const originalEnv = { TMPDIR: process.env.TMPDIR, COGPIT_WORKSPACES_DIR: process.env.COGPIT_WORKSPACES_DIR }
let server: Server
let device: HubDevice
let uploads = 0
let downloads = 0

beforeAll(async () => {
  let route: Middleware | undefined
  const use: UseFn = (path, handler) => {
    if (path === PREFIX) route = handler
  }
  registerWorkspaceRoutes(use)
  server = createServer((req, res) => {
    if (req.url === "/api/auth/verify") {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ valid: true, token: "device-token" }))
      return
    }
    if (req.method === "PUT") uploads++
    if (req.url?.startsWith(`${PREFIX}/downloads/`)) downloads++
    req.url = req.url!.slice(PREFIX.length) || "/"
    void route!(req, res, () => {
      res.statusCode = 404
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(async () => {
  const scratch = await tempDir("cogpit-handoff-")
  process.env.TMPDIR = join(scratch, "tmp")
  await mkdir(process.env.TMPDIR)
  process.env.COGPIT_WORKSPACES_DIR = join(scratch, "workspaces")
  await mkdir(join(scratch, "hub"))
  await initDeviceRegistry(join(scratch, "hub"))
  device = await addDevice({
    name: "Agent Box",
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    auth: "password",
    password: "hunter2secret1",
  })
  uploads = 0
  downloads = 0
})

afterEach(async () => {
  for (const name of ["TMPDIR", "COGPIT_WORKSPACES_DIR"] as const) {
    if (originalEnv[name] === undefined) delete process.env[name]
    else process.env[name] = originalEnv[name]
  }
  await cleanupTempDirs()
})

describe("handing a workspace to a device and back", () => {
  it("sends HEAD plus uncommitted work and returns the device's changes as a local branch", async () => {
    const repo = await makeRepo({ "src/app.ts": "export const a = 1\n", "README.md": "hi\n" })
    await writeFiles(repo, { "src/app.ts": "export const a = 2\n", "src/new.ts": "draft\n" })
    const userStatus = await gitOut(repo, ["status", "--porcelain"])

    const sent = await sendWorkspace(device.id, device.name, join(repo, "src"), "Fix the parser!", "req-parser-1")
    expect(sent.remoteCwd).toMatch(/fix-the-parser\/src$/)
    expect(await readFile(join(sent.remoteCwd, "app.ts"), "utf8")).toBe("export const a = 2\n")
    expect(await readFile(join(sent.remoteCwd, "new.ts"), "utf8")).toBe("draft\n")
    // The user's own tree is exactly as it was.
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe(userStatus)
    expect(handoffBriefing(sent, "mac")).toContain("uncommitted changes committed on top")

    // The session on the device commits one change and leaves another uncommitted.
    const worktree = join(sent.remoteCwd, "..")
    await writeFiles(worktree, { "src/app.ts": "export const a = 3\n" })
    await commitAll(worktree, "device work")
    await writeFiles(worktree, { "docs/notes.md": "done\n" })

    const back = await fetchWorkspaceBack(device.id, sent.handoff)
    expect(back.branchUpdated).toBe(true)
    expect(back.branch).toBe(sent.handoff.branch)
    expect(back.branch).toMatch(/^cogpit\/agent-box\/fix-the-parser/)
    expect(back.files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "docs/notes.md", additions: 1, deletions: 0 },
      { path: "src/app.ts", additions: 1, deletions: 1 },
    ])
    expect(await gitOut(repo, ["show", `${back.branch}:docs/notes.md`])).toBe("done")
    expect(await gitOut(repo, ["status", "--porcelain"])).toBe(userStatus)

    // Nothing changed since: nothing is downloaded again.
    const downloaded = downloads
    expect((await fetchWorkspaceBack(device.id, sent.handoff)).tip).toBe(back.tip)
    expect(downloads).toBe(downloaded)

    // Discarding removes the device's worktree and the private refs, keeps the branch.
    await discardWorkspace(device.id, sent.handoff)
    await expect(readFile(join(sent.remoteCwd, "app.ts"), "utf8")).rejects.toThrow()
    expect(await gitOut(repo, ["for-each-ref", "refs/cogpit"])).toBe("")
    expect(await gitOut(repo, ["rev-parse", back.branch])).toBe(back.tip)
  })

  it("imports once for a retried request", async () => {
    const repo = await makeRepo({ "a.txt": "1\n" })
    const first = await sendWorkspace(device.id, device.name, repo, "retry", "req-retry-1")
    const again = await sendWorkspace(device.id, device.name, repo, "retry", "req-retry-1")
    expect(again.handoff.workspaceId).toBe(first.handoff.workspaceId)
  })

  it("leaves a branch the user moved on or checked out, and says where the work is", async () => {
    const repo = await makeRepo({ "a.txt": "1\n" })
    const sent = await sendWorkspace(device.id, device.name, repo, "keep", "req-keep-1")
    const worktree = sent.remoteCwd
    await writeFiles(worktree, { "a.txt": "2\n" })
    const first = await fetchWorkspaceBack(device.id, sent.handoff)
    expect(first.branchUpdated).toBe(true)

    // The user adds a commit of their own on the returned branch.
    await gitOut(repo, ["checkout", "-q", sent.handoff.branch])
    await writeFiles(repo, { "mine.txt": "mine\n" })
    await commitAll(repo, "user work")
    const userTip = await gitOut(repo, ["rev-parse", "HEAD"])

    await writeFiles(worktree, { "a.txt": "3\n" })
    const second = await fetchWorkspaceBack(device.id, sent.handoff)
    expect(second.branchUpdated).toBe(false)
    expect(await gitOut(repo, ["rev-parse", sent.handoff.branch])).toBe(userTip)
    expect(await gitOut(repo, ["show", `${second.ref}:a.txt`])).toBe("3")

    // The branch never took that work, so discarding must not drop the ref it was reported at.
    await discardWorkspace(device.id, sent.handoff)
    expect(await gitOut(repo, ["rev-parse", second.ref])).toBe(second.tip)
    await expect(readFile(join(worktree, "a.txt"), "utf8")).rejects.toThrow()
  })

  it("sends only what the device lacks the second time", async () => {
    const repo = await makeRepo({ "a.txt": "1\n" })
    await sendWorkspace(device.id, device.name, repo, "first", "req-first-1")
    const firstUploads = uploads
    expect(firstUploads).toBeGreaterThan(0)

    const again = await sendWorkspace(device.id, device.name, repo, "first", "req-first-2")
    expect(uploads).toBe(firstUploads)
    expect(again.handoff.workspaceId).toMatch(/first-2$/)

    const back = await fetchWorkspaceBack(device.id, again.handoff)
    expect(back.files).toEqual([])
    expect(back.tip).toBe(again.handoff.base)
  })
})
