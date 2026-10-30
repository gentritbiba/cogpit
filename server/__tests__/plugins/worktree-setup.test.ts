// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetEditionForTest, PERSONAL_EDITION } from "../../edition"
import { installFakeEdition } from "../edition/fakeEdition"
import { mkdtemp, mkdir, readFile, rm, writeFile, access, realpath } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { WorktreeSetupStore, type WorktreeSetupOperation } from "../../plugins/integrations/worktreeSetup/store"
import { WorktreeSetupService, type WorktreeSetupGrant } from "../../plugins/integrations/worktreeSetup/service"
import { gitOutput } from "../../sessionStartup/project"
import { registerWorktreeStartupStep, WorktreeStartups, type StartupLifecycle } from "../../sessionStartup/readiness"
import type { StartupAuthorizationContext } from "../../../shared/contracts/sessionStartup"
import { prepareManagedWorktree } from "../../agents/managedWorktree"

let root: string
let cwd: string
let store: WorktreeSetupStore
let service: WorktreeSetupService
let startups: WorktreeStartups
let unregister: () => void
let grant: WorktreeSetupGrant | null
let recipeId: number
const installed: WorktreeSetupGrant = { pluginId: "cogpit.worktree-setup", digest: "a".repeat(64), name: "Worktree setup" }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cogpit-setup-test-"))); cwd = join(root, "project")
  recipeId = 0
  await mkdir(cwd)
  await gitOutput(cwd, ["init"])
  await gitOutput(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"])
  store = new WorktreeSetupStore(() => join(root, "data"))
  grant = installed
  service = new WorktreeSetupService({ current: async () => grant }, store)
  startups = new WorktreeStartups()
  unregister = registerWorktreeStartupStep(service.step)
})
afterEach(async () => { await startups.close(); unregister(); await rm(root, { recursive: true, force: true }) })
function run<T>(options: { worktreeName?: string; authorize?: (context: StartupAuthorizationContext) => Promise<void>; signal?: AbortSignal; start: (lifecycle: StartupLifecycle) => Promise<T> }) {
  return startups.run({ scope: "user-a", projectCwd: cwd, worktreeName: options.worktreeName ?? "fixture", authorize: options.authorize, signal: options.signal, start: options.start })
}
function act(id: string, action: "retry" | "cancel") {
  return service.execute({ integration: "worktreeSetup", operation: "act", operationId: id, action }, { pluginId: installed.pluginId, principal: "user-a", workspacePath: cwd, request: { headers: {} } as never, authorize: async () => {} })
}
async function worktree() { const path = join(root, "external-checkout"); await gitOutput(cwd, ["worktree", "add", "-b", "fixture-worktree", path]); return path }
async function project(scope = "user-a") { return store.project(scope, cwd) }
async function recipe(directory: string, source: string) {
  const file = `setup-${++recipeId}.cjs`
  await writeFile(join(directory, file), source)
  return `node ${file}`
}
function savedOperation(matches: (operation: WorktreeSetupOperation) => boolean): Promise<void> {
  const save = store.save.bind(store)
  return new Promise((resolve) => {
    const observer = vi.spyOn(store, "save").mockImplementation(async (project) => {
      await save(project)
      if (matches(project.state.operations[0])) { observer.mockRestore(); resolve() }
    })
  })
}

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
  await store.configure(current, { command: await recipe(initialized, "require('node:fs').writeFileSync('setup-marker', 'ready'); process.stdout.write('setup-output')"), trusted: true })
  const authorization = vi.fn(async () => {})
  let prompt = false
  const result = await run({ worktreeName: "fixture", authorize: authorization, start: async (lifecycle) => {
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
  await store.configure(current, { command: await recipe(initialized, "require('node:fs').writeFileSync('marker', 'partial'); process.stdout.write('failed'); process.exitCode = 7"), trusted: true })
  const prompt = vi.fn()
  const failed = savedOperation((operation) => operation.stage === "failed")
  const running = run({ worktreeName: "fixture", start: async ({ beforeFirstTurn }) => {
    const first = beforeFirstTurn({ cwd: initialized })
    expect(beforeFirstTurn({ cwd: initialized })).toBe(first)
    await first; prompt()
  } })
  await failed
  expect(current.state.operations[0]).toMatchObject({ stage: "failed", exitCode: 7 })
  expect(prompt).not.toHaveBeenCalled()
  expect(await readFile(join(initialized, "marker"), "utf8")).toBe("partial")
  await store.configure(current, { command: await recipe(initialized, "process.stdout.write('retry-ok')"), trusted: true })
  await act(current.state.operations[0].id, "retry")
  await running
  expect(prompt).toHaveBeenCalledOnce()
  expect(current.state.operations[0]).toMatchObject({ stage: "ready", attempt: 2, output: "failedretry-ok" })
  expect(await readFile(join(initialized, "marker"), "utf8")).toBe("partial")
})

it("cancels failed setup without delivering a prompt or removing its worktree", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "exit 2", trusted: true })
  const prompt = vi.fn()
  const failed = savedOperation((operation) => operation.stage === "failed")
  const running = run({ worktreeName: "fixture", start: async ({ beforeFirstTurn }) => { await beforeFirstTurn({ cwd: initialized }); prompt() } })
  const rejected = expect(running).rejects.toThrow("cancelled")
  await failed
  expect(current.state.operations[0].stage).toBe("failed")
  await act(current.state.operations[0].id, "cancel")
  await rejected
  expect(prompt).not.toHaveBeenCalled()
  expect(current.state.operations[0].stage).toBe("cancelled")
  await access(initialized)
})

it("never discovers or executes repository-declared commands without a recipe", async () => {
  const current = await project(); const initialized = await worktree()
  await writeFile(join(initialized, "package.json"), JSON.stringify({ scripts: { setup: "touch should-not-run" } }))
  await run({ worktreeName: "fixture", start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: initialized }) })
  expect(current.state.operations[0]).toMatchObject({ stage: "ready", attempt: 0, output: "" })
  await expect(access(join(initialized, "should-not-run"))).rejects.toThrow()
})

it("honors native custom hook directories and returns them accurately, while checking their canonical path", async () => {
  const current = await project(); const custom = join(root, "hook-checkout")
  await mkdir(custom)
  await store.configure(current, { command: await recipe(custom, "require('node:fs').writeFileSync('marker', 'hook-ready')"), trusted: true })
  await run({ worktreeName: "custom", start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: custom, nativeWorktree: true }) })
  expect(await readFile(join(custom, "marker"), "utf8")).toBe("hook-ready")
  expect(current.state.operations[0].cwd).toBe(custom)
})

it("aborts on revoked authority rather than retrying or executing a setup command", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "touch forbidden", trusted: true })
  let calls = 0
  const refused = new Error("Execution grant revoked")
  await expect(run({ worktreeName: "fixture", authorize: async () => { if (++calls > 1) throw refused }, start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: initialized }) })).rejects.toBe(refused)
  expect(current.state.operations[0].stage).toBe("interrupted")
  await expect(access(join(initialized, "forbidden"))).rejects.toThrow()
})

it("refuses unrelated cwd before command I/O", async () => {
  const current = await project()
  await expect(run({ worktreeName: "fixture", start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: root }) })).rejects.toThrow()
  expect(current.state.operations[0].stage).toBe("interrupted")
})

it("bounds noisy output and persists the newest tail", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: await recipe(initialized, "process.stdout.write('x'.repeat(100000)); process.stdout.write('newest')"), trusted: true })
  await run({ worktreeName: "fixture", start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: initialized }) })
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
  expect(await realpath(await gitOutput(first.cwd, ["rev-parse", "--show-toplevel"]))).toBe(await realpath(first.cwd))
  await writeFile(join(first.cwd, "dirty"), "preserved")
  expect(await readFile(join(first.cwd, "dirty"), "utf8")).toBe("preserved")
})


it("terminates setup if native creation fails while its readiness callback is running", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: await recipe(initialized, "process.stdout.write('running'); setInterval(() => {}, 1000)"), trusted: true })
  const running = savedOperation((operation) => operation.output === "running")
  await expect(run({ worktreeName: "fixture", start: async ({ beforeFirstTurn }) => {
    const pending = beforeFirstTurn({ cwd: initialized })
    void pending.catch(() => {})
    await running
    expect(current.state.operations[0].output).toBe("running")
    throw new Error("Native transport disconnected")
  } })).rejects.toThrow("Native transport disconnected")
  expect(current.state.operations[0]).toMatchObject({ stage: "interrupted", error: "Native transport disconnected" })
})

it("neither reads nor runs a saved recipe while the plugin is not installed and enabled", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "touch should-not-run", trusted: true })
  grant = null
  const reads = vi.spyOn(store, "project")
  const prompt = vi.fn()
  await run({ start: async ({ beforeFirstTurn }) => { await beforeFirstTurn({ cwd: initialized }); prompt() } })
  expect(prompt).toHaveBeenCalledOnce()
  expect(reads).not.toHaveBeenCalled()
  await expect(access(join(initialized, "should-not-run"))).rejects.toThrow()
  expect(current.state.operations).toHaveLength(0)
})

it("ends a startup waiting for retry when the plugin is disabled, without releasing the first prompt", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "exit 3", trusted: true })
  const prompt = vi.fn()
  const failed = savedOperation((operation) => operation.stage === "failed")
  const running = run({ start: async ({ beforeFirstTurn }) => { await beforeFirstTurn({ cwd: initialized }); prompt() } })
  const rejected = expect(running).rejects.toThrow("disabled")
  await failed
  grant = null
  service.abort(installed.pluginId)
  await rejected
  expect(prompt).not.toHaveBeenCalled()
  expect(current.state.operations[0]).toMatchObject({ stage: "interrupted", error: expect.stringContaining("disabled") })
  expect(current.state.recipe?.command).toBe("exit 3")
  await access(initialized)
})

it("refuses to run a recipe once the installed package changed after startup began", async () => {
  const current = await project(); const initialized = await worktree()
  await store.configure(current, { command: "touch forbidden", trusted: true })
  await expect(run({ start: async ({ beforeFirstTurn }) => { grant = { ...installed, digest: "b".repeat(64) }; await beforeFirstTurn({ cwd: initialized }) } })).rejects.toThrow("disabled or changed")
  await expect(access(join(initialized, "forbidden"))).rejects.toThrow()
})

describe("frame operations", () => {
  const caller = (principal = "owner") => ({ pluginId: installed.pluginId, principal, workspacePath: cwd, request: { headers: {} } as never, authorize: async () => {} })
  it("saves a proposed command only through a one-time confirmation by the same owner and project", async () => {
    const { proposalId } = await service.execute({ integration: "worktreeSetup", operation: "propose", command: "echo configured", timeoutMs: 120_000 }, caller()) as { proposalId: string }
    expect((await store.project("local", cwd)).state.recipe).toBeNull()
    await expect(service.confirm(proposalId, caller("user-b"))).rejects.toThrow("review it again")
    await expect(service.confirm(proposalId, { ...caller(), pluginId: "cogpit.other" })).rejects.toThrow("review it again")
    const snapshot = await service.confirm(proposalId, caller())
    expect(snapshot.recipe).toMatchObject({ command: "echo configured", timeoutMs: 120_000 })
    await expect(service.confirm(proposalId, caller())).rejects.toThrow("review it again")
    expect((await store.project("user-b", cwd)).state.recipe).toBeNull()
  })
  it("keeps host paths and session ids out of the snapshot a plugin reads", async () => {
    const initialized = await worktree()
    await run({ start: async ({ beforeFirstTurn }) => beforeFirstTurn({ cwd: initialized, sessionId: "native-id" }) })
    const snapshot = await service.execute({ integration: "worktreeSetup", operation: "snapshot" }, caller("user-a"))
    expect(JSON.stringify(snapshot)).not.toContain(root)
    expect(JSON.stringify(snapshot)).not.toContain("native-id")
    expect(snapshot).toMatchObject({ operations: [{ worktreeName: "fixture", stage: "ready" }] })
  })
  it("offers only the root package's scripts", async () => {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { bootstrap: "echo ready" } }))
    expect(await service.execute({ integration: "worktreeSetup", operation: "scripts" }, caller())).toEqual({ scripts: [{ name: "bootstrap", command: "echo ready" }] })
  })
  it("refuses every operation when the owner lacks host terminal access", async () => {
    installFakeEdition({ me: () => ({ ...PERSONAL_EDITION.me({} as never), capabilities: { ...PERSONAL_EDITION.me({} as never).capabilities, terminal: false } }) })
    try {
      for (const operation of ["snapshot", "scripts"] as const) await expect(service.execute({ integration: "worktreeSetup", operation }, caller())).rejects.toThrow("Current host-file")
      await expect(service.execute({ integration: "worktreeSetup", operation: "propose", command: "echo", timeoutMs: 60_000 }, caller())).rejects.toThrow("Current host-file")
    } finally { __resetEditionForTest() }
  })
})
