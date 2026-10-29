// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { access, mkdtemp, mkdir, realpath, rm } from "node:fs/promises"
import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The trigger runner's real default creator: `createSession`, the worktree
 * setup service and its startup authority, over a real git project. Only the
 * provider runtime is a fake, which creates the worktree itself and reports
 * whether the session's first input was handed over.
 */

const runtime = vi.hoisted(() => ({
  start: undefined as undefined | ((request: Record<string, unknown>) => Promise<unknown>),
}))
vi.mock("../../agents/runtimes", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  runtimeFor: (kind: string) => ({
    kind,
    instanceId: "default",
    descriptor: { displayName: "Test agent", capabilities: { worktrees: true } },
    start: (request: Record<string, unknown>) => runtime.start!(request),
    stop: async () => {},
  }),
}))

import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { setDataRoot } from "../../config"
import { __resetEditionForTest } from "../../edition"
import { closeCommandDispatcher, commandDispatcher } from "../../lib/durableSend"
import { __resetLiveAuthoritiesForTest, issueExecutionGrant, resolveExecution, revokeExecutionGrant } from "../../lib/triggers/authority"
import { defaultExecutor, registerTriggerHandler, TriggerRunner } from "../../lib/triggers/runner"
import { setRequestAuthentication } from "../../requestAuthentication"
import { setRequestPrincipal } from "../../requestPrincipal"
import { __resetSessionsForTest, createSessionToken } from "../../security"
import { gitOutput } from "../../worktreeSetup/project"
import { worktreeSetupService } from "../../worktreeSetup/service"
import { installFakeEdition, useAccountSignIn } from "../edition/fakeEdition"
import { fakeEditionAuth } from "../edition/fakeAuth"
import { worktreeSetupStore } from "../../worktreeSetup/store"
import { ALL_CAPABILITIES } from "../../../shared/contracts/identity"

let root: string
let project: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cogpit-trigger-creation-")))
  project = join(root, "project")
  await mkdir(project)
  await gitOutput(project, ["init"])
  await gitOutput(project, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"])
  setDataRoot(join(root, "data"))
})
afterEach(async () => {
  closeCommandDispatcher()
  __resetEditionForTest(); __resetSessionsForTest(); __resetLiveAuthoritiesForTest()
  await worktreeSetupService.close()
  await rm(root, { recursive: true, force: true })
})

/** A provider that makes the worktree, waits on `gate`, then asks for readiness before its first input. */
function fakeProvider(gate: Promise<void> = Promise.resolve()) {
  const firstInput = vi.fn()
  const started = vi.fn()
  runtime.start = async (request) => {
    started()
    const cwd = join(root, `worktree-${String(request.worktreeName)}`)
    await gitOutput(project, ["worktree", "add", "-b", String(request.worktreeName), cwd])
    ;(request.onSessionId as ((id: string) => void) | undefined)?.("native-session-1")
    await gate
    await (request.beforeFirstTurn as (identity: { sessionId: string; cwd: string }) => Promise<void>)({ sessionId: "native-session-1", cwd })
    firstInput(request.message)
    return { sessionId: "native-session-1", dirName: request.dirName, fileName: "native-session-1.jsonl", filePath: join(root, "native-session-1.jsonl"), cwd }
  }
  return { firstInput, started }
}

function runner(resolve = resolveExecution) {
  const dispatcher = commandDispatcher()
  const created = new TriggerRunner(dispatcher, { ...defaultExecutor, resolve })
  dispatcher.onTick((lease) => created.tick(lease))
  return { dispatcher, store: dispatcher.store, runner: created }
}

const dirName = () => descriptorFor("claude").dirName.encode(project)
const target = () => ({ agent: "claude" as const, instanceId: "default", dirName: dirName(), cwd: project, workspace: "nightly" })

describe("the default trigger creator", () => {
  it("starts a named-worktree session in an edition that signs accounts in, once its owner reauthorized it live", async () => {
    useAccountSignIn()
    const principal = { userId: "user-1", username: "ada", role: "member" }
    const token = createSessionToken("127.0.0.1", undefined, principal)
    const req = new IncomingMessage(new Socket())
    setRequestPrincipal(req, principal)
    setRequestAuthentication(req, { kind: "session", token, principal })
    const provider = fakeProvider()
    const unregister = registerTriggerHandler("test", { prepare: async () => ({ action: "session.create", target: target(), input: { dirName: dirName(), cwd: project, worktreeName: "nightly", message: "nightly review" } }) })
    const { dispatcher, store, runner: scheduler } = runner()
    try {
      const grant = await issueExecutionGrant(req, { actions: ["session.create"], target: target(), label: "Nightly" }, "user-1")
      const { occurrence } = store.recordOccurrence("user-1", { triggerId: "task-0001", kind: "test", key: "a", dueAt: Date.now(), action: "session.create", grant: { grantId: grant.id, revision: 1 }, request: {} })
      await dispatcher.tick()
      await vi.waitFor(() => expect(store.occurrence("user-1", occurrence.id)).toMatchObject({ state: "held", hold: "reauthorize" }))
      scheduler.reauthorizeLive(req, "user-1", occurrence.id)
      await vi.waitFor(() => expect(store.occurrence("user-1", occurrence.id)).toMatchObject({ state: "completed", sessionId: "native-session-1" }), { timeout: 10_000 })
      expect(provider.firstInput).toHaveBeenCalledWith("nightly review")
    } finally { unregister() }
  }, 20_000)

  it("holds for reauthorization without a creation claim when the grant is revoked before setup", async () => {
    const provider = fakeProvider()
    const unregister = registerTriggerHandler("test", { prepare: async () => ({ action: "session.create", target: target(), input: { dirName: dirName(), cwd: project, worktreeName: "nightly", message: "nightly review" } }) })
    let calls = 0
    const { dispatcher, store } = runner(async (...args) => {
      // The second resolution is the startup check before setup: the owner revokes just before it.
      if (++calls === 2) await revokeExecutionGrant(args[0].grantId, "Owner revoked it")
      return resolveExecution(...args)
    })
    try {
      const grant = await issueExecutionGrant(new IncomingMessage(new Socket()), { actions: ["session.create"], target: target(), label: "Nightly" }, "local")
      const { occurrence } = store.recordOccurrence("local", { triggerId: "task-0001", kind: "test", key: "a", dueAt: Date.now(), action: "session.create", grant: { grantId: grant.id, revision: 1 }, request: {} })
      await dispatcher.tick()
      await vi.waitFor(() => expect(store.occurrence("local", occurrence.id)).toMatchObject({ state: "held", hold: "reauthorize", reason: expect.stringMatching(/revoked/) }), { timeout: 10_000 })
      expect(provider.started).not.toHaveBeenCalled()
      expect(store.operation("local", occurrence.creationId)).toBeNull()
    } finally { unregister() }
  }, 20_000)

  it("gives the session no first input when the grant is revoked while it starts, and leaves the outcome to reconcile", async () => {
    let release!: () => void
    const provider = fakeProvider(new Promise((resolve) => { release = resolve }))
    const unregister = registerTriggerHandler("test", { prepare: async () => ({ action: "session.create", target: target(), input: { dirName: dirName(), cwd: project, worktreeName: "nightly", message: "nightly review" } }) })
    const { dispatcher, store } = runner()
    try {
      const grant = await issueExecutionGrant(new IncomingMessage(new Socket()), { actions: ["session.create"], target: target(), label: "Nightly" }, "local")
      const { occurrence } = store.recordOccurrence("local", { triggerId: "task-0001", kind: "test", key: "a", dueAt: Date.now(), action: "session.create", grant: { grantId: grant.id, revision: 1 }, request: {} })
      await dispatcher.tick()
      await vi.waitFor(() => expect(provider.started).toHaveBeenCalled(), { timeout: 10_000 })
      await revokeExecutionGrant(grant.id, "Owner revoked it")
      release()
      await vi.waitFor(() => expect(store.occurrence("local", occurrence.id)).toMatchObject({ state: "unknown" }), { timeout: 10_000 })
      expect(provider.firstInput).not.toHaveBeenCalled()
    } finally { unregister() }
  }, 20_000)
})

describe("a trigger creation that would run the project's setup recipe", () => {
  async function signedInEdition(capabilities: { allowed: boolean }) {
    const principal = { userId: "user-1", username: "ada", role: "member" }
    installFakeEdition({
      auth: fakeEditionAuth(),
      me: () => ({ authenticated: true, edition: "team" as const, user: null, capabilities: { ...ALL_CAPABILITIES, hostFiles: capabilities.allowed, terminal: capabilities.allowed } }),
    })
    const token = createSessionToken("127.0.0.1", undefined, principal)
    const req = new IncomingMessage(new Socket())
    setRequestPrincipal(req, principal)
    setRequestAuthentication(req, { kind: "session", token, principal })
    const saved = await worktreeSetupStore.project("user-1", project)
    await worktreeSetupStore.configure(saved, { command: "printf ran > recipe-marker", trusted: true })
    return req
  }

  async function run(req: IncomingMessage, provider: ReturnType<typeof fakeProvider>) {
    const unregister = registerTriggerHandler("test", { prepare: async () => ({ action: "session.create", target: target(), input: { dirName: dirName(), cwd: project, worktreeName: "nightly", message: "nightly review" } }) })
    const { dispatcher, store, runner: scheduler } = runner()
    const grant = await issueExecutionGrant(req, { actions: ["session.create"], target: target(), label: "Nightly" }, "user-1")
    const { occurrence } = store.recordOccurrence("user-1", { triggerId: "task-0001", kind: "test", key: "a", dueAt: Date.now(), action: "session.create", grant: { grantId: grant.id, revision: 1 }, request: {} })
    await dispatcher.tick()
    await vi.waitFor(() => expect(store.occurrence("user-1", occurrence.id)!.hold).toBe("reauthorize"))
    scheduler.reauthorizeLive(req, "user-1", occurrence.id)
    return { store, occurrence, unregister, provider }
  }
  const markerRan = () => access(join(root, "worktree-nightly", "recipe-marker")).then(() => true, () => false)

  it("runs the recipe and the first input while the account may run setup commands", async () => {
    const req = await signedInEdition({ allowed: true })
    const { store, occurrence, unregister, provider } = await run(req, fakeProvider())
    try {
      await vi.waitFor(() => expect(store.occurrence("user-1", occurrence.id)!.state).toBe("completed"), { timeout: 10_000 })
      expect(await markerRan()).toBe(true)
      expect(provider.firstInput).toHaveBeenCalledTimes(1)
    } finally { unregister() }
  }, 20_000)

  it("starts nothing when the account lost host-file or terminal access before it was reauthorized", async () => {
    const req = await signedInEdition({ allowed: false })
    const { store, occurrence, unregister, provider } = await run(req, fakeProvider())
    try {
      await vi.waitFor(() => expect(store.occurrence("user-1", occurrence.id)).toMatchObject({ state: "held", hold: "reauthorize", reason: expect.stringMatching(/host-file and terminal access/) }), { timeout: 10_000 })
      expect(provider.started).not.toHaveBeenCalled()
      expect(provider.firstInput).not.toHaveBeenCalled()
      expect(store.operation("user-1", occurrence.creationId)).toBeNull()
    } finally { unregister() }
  }, 20_000)

  it("withholds the recipe and the first input when access is withdrawn while the session initializes", async () => {
    const capabilities = { allowed: true }
    const req = await signedInEdition(capabilities)
    let release!: () => void
    const { store, occurrence, unregister, provider } = await run(req, fakeProvider(new Promise((resolve) => { release = resolve })))
    try {
      await vi.waitFor(() => expect(provider.started).toHaveBeenCalled(), { timeout: 10_000 })
      capabilities.allowed = false
      release()
      await vi.waitFor(() => expect(store.occurrence("user-1", occurrence.id)!.state).toBe("unknown"), { timeout: 10_000 })
      expect(await markerRan()).toBe(false)
      expect(provider.firstInput).not.toHaveBeenCalled()
    } finally { unregister() }
  }, 20_000)
})
