// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { WorktreeSetupStore } from "../../worktreeSetup/store"
import { WorktreeSetupService } from "../../worktreeSetup/service"
import { gitOutput } from "../../worktreeSetup/project"
import { prepareManagedWorktree } from "../../agents/managedWorktree"

let root: string
let cwd: string
let store: WorktreeSetupStore
let service: WorktreeSetupService
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cogpit-setup-test-")); cwd = join(root, "project")
  await mkdir(cwd)
  await gitOutput(cwd, ["init"])
  await gitOutput(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"])
  store = new WorktreeSetupStore(() => join(root, "data"))
  service = new WorktreeSetupService(store)
})
afterEach(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
async function worktree() { const path = join(root, "external-checkout"); await gitOutput(cwd, ["worktree", "add", "-b", "fixture-worktree", path]); return path }
async function project(scope = "user-a") { return store.project(scope, cwd) }

it("requires explicit user trust, scopes by account/project, and inherits across external worktrees", async () => {
  const current = await project()
  await expect(store.configure(current, { command: "echo unsafe" })).rejects.toThrow("trust")
  expect(current.state.recipe).toBeNull()
  await store.configure(current, { command: "echo configured", trusted: true })
  const external = await worktree()
  expect((await store.project("user-a", external)).state.recipe?.command).toBe("echo configured")
  expect((await project("user-b")).state.recipe).toBeNull()
  const loaded = new WorktreeSetupStore(() => join(root, "data"))
  expect((await loaded.project("user-a", cwd)).state.recipe?.command).toBe("echo configured")
  expect((await loaded.project("user-a", external)).cwd).toBe(external)
})

it("runs only in initialized cwd and awaits successful setup before the first prompt", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "printf ready > setup-marker; printf setup-output", trusted: true })
  const authorization = vi.fn(async () => {})
  let prompt = false
  const result = await service.run({ project: current, worktreeName: "fixture", authorize: authorization, start: async (lifecycle) => {
    await lifecycle.beforeFirstTurn({ cwd: initialized, sessionId: "native-id" })
    expect(await readFile(join(initialized, "setup-marker"), "utf8")).toBe("ready")
    prompt = true
    return { cwd: initialized }
  } })
  expect(result.cwd).toBe(initialized); expect(prompt).toBe(true)
  expect(current.state.operations[0]).toMatchObject({ stage: "ready", attempt: 1, exitCode: 0, output: "setup-output", cwd: initialized, sessionId: "native-id" })
  expect(authorization.mock.calls).toHaveLength(3)
  await expect(access(join(cwd, "setup-marker"))).rejects.toThrow()
  const reconnected = await new WorktreeSetupStore(() => join(root, "data")).project("user-a", cwd)
  expect(reconnected.state.operations[0].output).toBe("setup-output")
})

it("retains partial changes after failure, retries once in the same worktree and deduplicates readiness", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "printf partial > marker; printf failed; exit 7", trusted: true })
  const prompt = vi.fn()
  const running = service.run({ project: current, worktreeName: "fixture", start: async ({ beforeFirstTurn }) => {
    const first = beforeFirstTurn({ cwd: initialized })
    expect(beforeFirstTurn({ cwd: initialized })).toBe(first)
    await first; prompt()
  } })
  await vi.waitFor(() => expect(current.state.operations[0]).toMatchObject({ stage: "failed", exitCode: 7 }))
  expect(prompt).not.toHaveBeenCalled()
  expect(await readFile(join(initialized, "marker"), "utf8")).toBe("partial")
  await store.configure(current, { command: "printf retry-ok", trusted: true })
  service.act(current, current.state.operations[0].id, "retry")
  await running
  expect(prompt).toHaveBeenCalledOnce()
  expect(current.state.operations[0]).toMatchObject({ stage: "ready", attempt: 2, output: "failedretry-ok" })
  expect(await readFile(join(initialized, "marker"), "utf8")).toBe("partial")
})

it("cancels failed setup without delivering a prompt or removing its worktree", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "exit 2", trusted: true })
  const prompt = vi.fn()
  const running = service.run({ project: current, worktreeName: "fixture", start: async ({ beforeFirstTurn }) => { await beforeFirstTurn({ cwd: initialized }); prompt() } })
  const rejected = expect(running).rejects.toThrow("cancelled")
  await vi.waitFor(() => expect(current.state.operations[0].stage).toBe("failed"))
  service.act(current, current.state.operations[0].id, "cancel")
  await rejected
  expect(prompt).not.toHaveBeenCalled()
  expect(current.state.operations[0].stage).toBe("cancelled")
  await access(initialized)
})

it("never discovers or executes repository-declared commands without a recipe", async () => {
  const current = await project(); const initialized = await worktree()
  await writeFile(join(initialized, "package.json"), JSON.stringify({ scripts: { setup: "touch should-not-run" } }))
  await service.run({ project: current, worktreeName: "fixture", start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: initialized }) })
  expect(current.state.operations[0]).toMatchObject({ stage: "ready", attempt: 0, output: "" })
  await expect(access(join(initialized, "should-not-run"))).rejects.toThrow()
})

it("honors native custom hook directories and returns them accurately, while checking their canonical path", async () => {
  const current = await project(); const custom = join(root, "hook-checkout")
  await mkdir(custom)
  await store.configure(current, { command: "printf hook-ready > marker", trusted: true })
  await service.run({ project: current, worktreeName: "custom", start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: custom, nativeWorktree: true }) })
  expect(await readFile(join(custom, "marker"), "utf8")).toBe("hook-ready")
  expect(current.state.operations[0].cwd).toBe(custom)
})

it("aborts on revoked authority rather than retrying or executing a setup command", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "touch forbidden", trusted: true })
  let calls = 0
  const refused = new Error("Execution grant revoked")
  await expect(service.run({ project: current, worktreeName: "fixture", authorize: async () => { if (++calls > 1) throw refused }, start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: initialized }) })).rejects.toBe(refused)
  expect(current.state.operations[0].stage).toBe("interrupted")
  await expect(access(join(initialized, "forbidden"))).rejects.toThrow()
})

it("refuses unrelated cwd before command I/O", async () => {
  const current = await project()
  await expect(service.run({ project: current, worktreeName: "fixture", start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: root }) })).rejects.toThrow()
  expect(current.state.operations[0].stage).toBe("interrupted")
})

it("bounds noisy output and persists the newest tail", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "head -c 100000 /dev/zero | tr '\\0' x; printf newest", trusted: true })
  await service.run({ project: current, worktreeName: "fixture", start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: initialized }) })
  const operation = current.state.operations[0]
  expect(operation.output.length).toBeLessThanOrEqual(64000)
  expect(operation.output.endsWith("newest")).toBe(true); expect(operation.outputTruncated).toBe(true)
})

it("creates managed worktrees without reusing or deleting user-owned paths", async () => {
  const request = { cwd, dirName: "project", worktreeName: "setup", beforeFirstTurn: async () => {} }
  const first = await prepareManagedWorktree(request)
  const second = await prepareManagedWorktree(request)
  expect(first.cwd).not.toBe(second.cwd)
  expect(first.worktreeName).toBeUndefined()
  expect(await gitOutput(first.cwd, ["rev-parse", "--show-toplevel"])).toBe(first.cwd)
  await writeFile(join(first.cwd, "dirty"), "preserved")
  expect(await readFile(join(first.cwd, "dirty"), "utf8")).toBe("preserved")
})


it("terminates setup if native creation fails while its readiness callback is running", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "printf running; sleep 30", trusted: true })
  await expect(service.run({ project: current, worktreeName: "fixture", start: async ({ beforeFirstTurn }) => {
    const pending = beforeFirstTurn({ cwd: initialized })
    void pending.catch(() => {})
    await vi.waitFor(() => expect(current.state.operations[0].output).toBe("running"))
    throw new Error("Native transport disconnected")
  } })).rejects.toThrow("Native transport disconnected")
  expect(current.state.operations[0]).toMatchObject({ stage: "interrupted", error: "Native transport disconnected" })
})
