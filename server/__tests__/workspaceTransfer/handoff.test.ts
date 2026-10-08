// @vitest-environment node
import { mkdir, readdir, readFile, stat } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import { addDevice, initDeviceRegistry, updateDevice, type HubDevice } from "../../hub/registry"
import { registerWorkspaceRoutes } from "../../routes/workspaces"
import { discardWorkspace, fetchWorkspaceBack, handoffBriefing, sendWorkspace } from "../../workspaceTransfer/handoff"
import { cleanupTempDirs, commitAll, gitOut, makeRepo, tempDir, writeFiles } from "./gitFixtures"
import { workspaceDetailsForCwd } from "../../workspaceTransfer/status"

const projects = vi.hoisted(() => ({ paths: [] as string[] }))
vi.mock("../../agents", () => ({ allStores: () => [{ listProjects: async () => projects.paths.map((path) => ({ path })) }] }))

/**
 * A task handed to another machine and back, over HTTP against the real
 * device routes, with real git on both sides.
 */

const PREFIX = "/api/workspaces"
const originalEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR, COGPIT_WORKSPACES_DIR: process.env.COGPIT_WORKSPACES_DIR }
let server: Server
let device: HubDevice
let uploads = 0
let downloads = 0
let environmentCapability: number | undefined

beforeAll(async () => {
  let route: Middleware | undefined
  const use: UseFn = (path, handler) => {
    if (path === PREFIX) route = handler
  }
  registerWorkspaceRoutes(use)
  server = createServer((req, res) => {
    if (req.url === "/api/hello") {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ sessionApi: 1, workspaceEnvironment: environmentCapability }))
      return
    }
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
  process.env.TEMP = process.env.TMPDIR
  process.env.TMP = process.env.TMPDIR
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
  environmentCapability = undefined
  projects.paths = []
})

afterEach(async () => {
  for (const name of ["TMPDIR", "TEMP", "TMP", "COGPIT_WORKSPACES_DIR"] as const) {
    if (originalEnv[name] === undefined) delete process.env[name]
    else process.env[name] = originalEnv[name]
  }
  await cleanupTempDirs()
})

describe("handing a workspace to a device and back", { timeout: 20_000 }, () => {
  it("reuses the target clone at the caller snapshot and copies its env independently", async () => {
    environmentCapability = 1
    const caller = await makeRepo({ ".gitignore": ".env*\n", "app.ts": "v1" })
    await gitOut(caller, ["remote", "add", "origin", "https://github.com/acme/env-app.git"])
    const target = join(await tempDir("cogpit-env-target-"), "target-name")
    await gitOut(caller, ["clone", "-q", caller, target])
    await gitOut(target, ["remote", "set-url", "origin", "git@github.com:acme/env-app.git"])
    projects.paths = [target]
    await writeFiles(caller, { ".env.local": "SECRET=caller", "app.ts": "v2" })
    await writeFiles(target, { ".env.local": "SECRET=target", "app.ts": "local target edit" })
    const targetStatus = await gitOut(target, ["status", "--porcelain"])
    const sent = await sendWorkspace(device.id, device.name, caller, "target", "req-env-target")
    expect(sent.environment).toEqual({ source: "target-checkout", files: [".env.local"], checkout: target })
    expect(await workspaceDetailsForCwd(sent.remoteCwd)).toEqual({ environment: sent.environment, run: sent.run })
    expect(await readFile(join(sent.remoteCwd, ".env.local"), "utf8")).toBe("SECRET=target")
    expect(await readFile(join(sent.remoteCwd, "app.ts"), "utf8")).toBe("v2")
    expect(await gitOut(sent.remoteCwd, ["rev-parse", "HEAD"])).toBe(sent.snapshot.snapshot)
    expect(await gitOut(target, ["worktree", "list", "--porcelain"])).toContain(sent.remoteCwd)
    expect(await gitOut(target, ["status", "--porcelain"])).toBe(targetStatus)
    expect((await stat(join(sent.remoteCwd, ".env.local"))).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(sent)).not.toContain("SECRET=target")
    expect(handoffBriefing(sent, "mac")).not.toContain("SECRET=target")
    await writeFiles(sent.remoteCwd, { ".env.local": "SECRET=edited-copy", "app.ts": "v3" })
    expect(await readFile(join(target, ".env.local"), "utf8")).toBe("SECRET=target")
    const returned = await fetchWorkspaceBack(device.id, sent.handoff)
    expect(returned.files.map((file) => file.path)).toEqual(["app.ts"])
    await discardWorkspace(device.id, sent.handoff)
    await expect(stat(sent.remoteCwd)).rejects.toThrow()
    expect(await workspaceDetailsForCwd(sent.remoteCwd)).toEqual({})
    expect(await readFile(join(target, ".env.local"), "utf8")).toBe("SECRET=target")
    expect(await gitOut(target, ["for-each-ref", "refs/heads/cogpit", "refs/cogpit"])).toBe("")
  })

  it("caller mode overrides target env, returns no secrets even if staged forcibly", async () => {
    environmentCapability = 1
    const repo = await makeRepo({ ".gitignore": ".env*\n", "app.ts": "v1" })
    projects.paths = [repo]
    await writeFiles(repo, { ".env.local": "SECRET=caller-sentinel" })
    const sent = await sendWorkspace(device.id, device.name, repo, "caller", "req-env-caller", { environmentMode: "caller" })
    expect(sent.environment?.source).toBe("caller")
    expect(await readFile(join(sent.remoteCwd, ".env.local"), "utf8")).toBe("SECRET=caller-sentinel")
    expect(await readdir(join(process.env.TMPDIR!, "cogpit-workspace-uploads"))).toEqual([])
    await writeFiles(sent.remoteCwd, { ".env.local": "SECRET=changed-sentinel", "app.ts": "v2" })
    await gitOut(sent.remoteCwd, ["add", "-f", ".env.local"])
    const returned = await fetchWorkspaceBack(device.id, sent.handoff)
    expect(await gitOut(repo, ["ls-tree", "-r", returned.branch])).not.toContain(".env.local")
    expect(returned.files.map((file) => file.path)).toEqual(["app.ts"])
    await gitOut(sent.remoteCwd, ["commit", "-q", "-m", "mistaken secret commit"])
    await expect(fetchWorkspaceBack(device.id, sent.handoff)).rejects.toThrow("secret bytes were not exported")
    // Direct discard removes credentials even when fetching is blocked.
    await discardWorkspace(device.id, sent.handoff)
    await expect(stat(join(sent.remoteCwd, ".env.local"))).rejects.toThrow()
  })

  it("blocks secret commits hidden on a merged side branch even after deletion", async () => {
    environmentCapability = 1
    const repo = await makeRepo({ ".gitignore": ".env*\n", "app.ts": "v1" })
    await writeFiles(repo, { ".env.local": "SECRET=merge-fixture" })
    const sent = await sendWorkspace(device.id, device.name, repo, "merge-secret", "req-merge-secret", { environmentMode: "caller" })
    await gitOut(sent.remoteCwd, ["checkout", "-q", "-b", "fixture-secret-side"])
    await gitOut(sent.remoteCwd, ["add", "-f", ".env.local"])
    await commitAll(sent.remoteCwd, "fixture env commit")
    await gitOut(sent.remoteCwd, ["rm", "-q", ".env.local"])
    await commitAll(sent.remoteCwd, "fixture env deletion")
    await gitOut(sent.remoteCwd, ["checkout", "-q", sent.remoteBranch])
    await gitOut(sent.remoteCwd, ["merge", "--no-ff", "-q", "fixture-secret-side", "-m", "fixture merge"])
    expect(await gitOut(sent.remoteCwd, ["log", "--format=%H", `${sent.handoff.base}..HEAD`, "--", ".env.local"])).toBe("")
    await expect(fetchWorkspaceBack(device.id, sent.handoff)).rejects.toThrow("secret bytes were not exported")
    await discardWorkspace(device.id, sent.handoff)
  })

  it("falls back to no env without a match; explicit target fails; none skips env", async () => {
    environmentCapability = 1
    const repo = await makeRepo({ ".gitignore": ".env*\n", "app.ts": "v1" })
    await writeFiles(repo, { ".env": "SECRET=must-stay" })
    const sent = await sendWorkspace(device.id, device.name, repo, "no-match", "req-no-match")
    expect(sent.environment?.source).toBe("none")
    await expect(stat(join(sent.remoteCwd, ".env"))).rejects.toThrow()
    // Remove the retained workspace so target mode cannot discover it.
    await discardWorkspace(device.id, sent.handoff)
    await expect(sendWorkspace(device.id, device.name, repo, "strict", "req-strict", { environmentMode: "target" })).rejects.toThrow("No unique target checkout")
    projects.paths = [repo]
    const none = await sendWorkspace(device.id, device.name, repo, "none", "req-env-none", { environmentMode: "none" })
    expect(none.environment).toMatchObject({ source: "none", files: [], checkout: repo })
    await expect(stat(join(none.remoteCwd, ".env"))).rejects.toThrow()
  })

  it("gates explicit provisioning on capability while old sessionApi devices retain legacy transfer", async () => {
    const repo = await makeRepo({ ".gitignore": ".env*\n", "app.ts": "v1" })
    await writeFiles(repo, { ".env": "SECRET=old-device-sentinel" })
    const old = await sendWorkspace(device.id, device.name, repo, "legacy", "req-legacy")
    expect(old.environment).toMatchObject({ source: "none", files: [], note: expect.stringContaining("legacy") })
    const before = uploads
    await expect(sendWorkspace(device.id, device.name, repo, "caller", "req-old-caller", { environmentMode: "caller" })).rejects.toMatchObject({ code: "DEVICE_TOO_OLD" })
    await expect(sendWorkspace(device.id, device.name, repo, "target", "req-old-target", { environmentMode: "target" })).rejects.toMatchObject({ code: "DEVICE_TOO_OLD" })
    expect(uploads).toBe(before)
    expect(await readFile(join(repo, ".env"), "utf8")).toBe("SECRET=old-device-sentinel")
  })

  it("refuses caller secrets on a device registered without authentication", async () => {
    environmentCapability = 1
    await updateDevice(device.id, { auth: "none" })
    const repo = await makeRepo({ ".gitignore": ".env*\n", "app.ts": "v1" })
    await writeFiles(repo, { ".env": "PRIVATE_FIXTURE" })
    await expect(sendWorkspace(device.id, device.name, repo, "no-auth", "req-no-auth", { environmentMode: "caller" })).rejects.toMatchObject({ code: "DEVICE_AUTH_REQUIRED" })
    expect(uploads).toBe(0)
  })

  it("allocates separate run contexts for parallel tasks", async () => {
    environmentCapability = 1
    const repo = await makeRepo({ "app.ts": "v1" })
    const [a, b] = await Promise.all([
      sendWorkspace(device.id, device.name, repo, "parallel", "req-parallel-a", { environmentMode: "none" }),
      sendWorkspace(device.id, device.name, repo, "parallel", "req-parallel-b", { environmentMode: "none" }),
    ])
    expect(a.run?.port).toBeGreaterThan(0)
    expect(a.run?.port).not.toBe(b.run?.port)
    expect(a.run?.composeProjectName).not.toBe(b.run?.composeProjectName)
    await discardWorkspace(device.id, a.handoff)
    await discardWorkspace(device.id, b.handoff)
  })

  it("runs two env-dependent apps on separate ports through an isolated device HTTP server", async () => {
    environmentCapability = 1
    const repo = await makeRepo({
      ".gitignore": ".env*\n",
      "app.cjs": `const http = require("node:http"); if (!process.env.RUNNABLE_SECRET) process.exit(1); http.createServer((req, res) => res.end("ready")).listen(Number(process.env.PORT), "127.0.0.1", () => process.send({ ready: true }));`,
    })
    await writeFiles(repo, { ".env.local": "RUNNABLE_SECRET=fixture-value" })
    const tasks = await Promise.all(["app-one", "app-two"].map((name) => sendWorkspace(device.id, device.name, repo, name, `req-${name}`, { environmentMode: "caller" })))
    const children: ChildProcess[] = []
    try {
      for (const task of tasks) {
        const child = spawn(process.execPath, ["--env-file=.env.local", "app.cjs"], { cwd: task.remoteCwd, env: { ...process.env, PORT: String(task.run!.port) }, stdio: ["ignore", "ignore", "ignore", "ipc"] })
        children.push(child)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Fixture app did not start")), 3000)
          child.once("error", (error) => { clearTimeout(timer); reject(error) })
          child.once("exit", () => { clearTimeout(timer); reject(new Error("Fixture app exited before readiness")) })
          child.once("message", () => { clearTimeout(timer); resolve() })
        })
      }
      for (const task of tasks) expect(await (await fetch(`http://127.0.0.1:${task.run!.port}`)).text()).toBe("ready")
    } finally {
      await Promise.all(children.map((child) => !child.pid || child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill() })))
      for (const task of tasks) await discardWorkspace(device.id, task.handoff)
    }
  }, 15_000)

  it("sends HEAD plus uncommitted work and returns the device's changes as a local branch", async () => {
    const repo = await makeRepo({ "src/app.ts": "export const a = 1\n", "README.md": "hi\n" })
    await writeFiles(repo, { "src/app.ts": "export const a = 2\n", "src/new.ts": "draft\n" })
    const userStatus = await gitOut(repo, ["status", "--porcelain"])

    const sent = await sendWorkspace(device.id, device.name, join(repo, "src"), "Fix the parser!", "req-parser-1")
    expect(sent.remoteCwd.replaceAll("\\", "/")).toMatch(/fix-the-parser\/src$/)
    expect((await readFile(join(sent.remoteCwd, "app.ts"), "utf8")).replace(/\r\n/g, "\n")).toBe("export const a = 2\n")
    expect((await readFile(join(sent.remoteCwd, "new.ts"), "utf8")).replace(/\r\n/g, "\n")).toBe("draft\n")
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
