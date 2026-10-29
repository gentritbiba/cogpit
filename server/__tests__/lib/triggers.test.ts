// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import { __resetEditionForTest, PERSONAL_EDITION, type EditionUnattended } from "../../edition"
import { installFakeEdition, useAccountSignIn } from "../edition/fakeEdition"
import { fakeEditionAuth } from "../edition/fakeAuth"
import { admitOccurrenceCommand, closeCommandDispatcher, commandDispatcher } from "../../lib/durableSend"
import { issueExecutionGrant, resolveExecution, revokeExecutionGrant, targetWithin } from "../../lib/triggers/authority"
import { defaultExecutor, registerTriggerHandler, TriggerRunner, type Prepared, type TriggerExecutor } from "../../lib/triggers/runner"
import { OrchestrationError } from "../../orchestration/store"
import { setRequestAuthentication } from "../../requestAuthentication"
import { setRequestPrincipal } from "../../requestPrincipal"
import { __resetSessionsForTest, createSessionToken, revokeSessionToken } from "../../security"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import type { AgentRuntime } from "../../agents/runtimeTypes"
import type { ExecutionTarget, TriggerOccurrence } from "../../../shared/contracts/triggers"

const target: ExecutionTarget & { sessionId: string } = { agent: "claude", instanceId: "default", sessionId: "native-1" }
const binding = { hostId: "local", agent: "claude" as const, instanceId: "default", sessionId: "native-1" }
const principal = { userId: "user-1", username: "ada", role: "member" }
const localRequest = () => new IncomingMessage(new Socket())
function signedIn(token: string) {
  const req = localRequest()
  setRequestPrincipal(req, principal)
  setRequestAuthentication(req, { kind: "session", token, principal })
  return req
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => { closeCommandDispatcher(); __resetEditionForTest(); __resetSessionsForTest(); vi.useRealTimers() })

describe("execution grants", () => {
  it("lets personal edition run exactly what the grant names until it is revoked", async () => {
    const grant = await issueExecutionGrant(localRequest(), { actions: ["session.send"], target, label: "Continue after the limit" }, "local")
    expect(grant).toMatchObject({ source: "personal", scope: "local", revision: 1, actions: ["session.send"] })
    const ref = { grantId: grant.id, revision: grant.revision }
    await expect(resolveExecution(ref, "session.send", target, "local")).resolves.toHaveProperty("req")
    await expect(resolveExecution(ref, "session.create", target, "local")).resolves.toEqual({ hold: expect.stringMatching(/beyond/) })
    await expect(resolveExecution(ref, "session.send", { ...target, sessionId: "native-2" }, "local")).resolves.toEqual({ hold: expect.stringMatching(/beyond/) })
    await expect(resolveExecution(ref, "session.send", target, "user-2")).resolves.toEqual({ hold: expect.stringMatching(/another account/) })
    await expect(resolveExecution({ ...ref, revision: 0 }, "session.send", target, "local")).resolves.toEqual({ hold: expect.stringMatching(/changed/) })
    await revokeExecutionGrant(grant.id, "User revoked it")
    await expect(resolveExecution({ ...ref, revision: 2 }, "session.send", target, "local")).resolves.toEqual({ hold: expect.stringMatching(/revoked: User revoked it/) })
  })

  it("matches a target field by field and refuses a send grant without session access", async () => {
    expect(targetWithin({ agent: "codex", instanceId: "default", dirName: "proj" }, { agent: "codex", instanceId: "default", dirName: "proj", cwd: "/x" })).toBe(true)
    expect(targetWithin({ agent: "codex", instanceId: "default", dirName: "proj" }, { agent: "codex", instanceId: "other", dirName: "proj" })).toBe(false)
    installFakeEdition({ access: { ...PERSONAL_EDITION.access, levelOf: async () => "view" } })
    await expect(issueExecutionGrant(localRequest(), { actions: ["session.send"], target, label: "x" }, "local")).rejects.toMatchObject({ status: 403 })
  })

  it("records a grant that always holds where the edition signs accounts in but cannot vouch for absent ones", async () => {
    useAccountSignIn()
    const grant = await issueExecutionGrant(signedIn("unused"), { actions: ["session.send"], target, label: "x" }, "user-1")
    expect(grant.source).toBe("none")
    await expect(resolveExecution({ grantId: grant.id, revision: 1 }, "session.send", target, "user-1")).resolves.toEqual({ hold: expect.stringMatching(/cannot run work while you are away/) })
  })

  it("asks the edition's unattended hook at issue and at every execution, and refuses an answer for another account", async () => {
    let answer: IncomingMessage | null = null
    const unattended: EditionUnattended = {
      issue: vi.fn(async () => ({ grantId: "edition-grant-1", revision: 3 })),
      resolve: vi.fn(async () => answer),
      revoke: vi.fn(async () => {}),
    }
    installFakeEdition({ auth: fakeEditionAuth(), unattended })
    const grant = await issueExecutionGrant(signedIn("unused"), { actions: ["session.send"], target, label: "x" }, "user-1")
    expect(grant).toMatchObject({ id: "edition-grant-1", revision: 3, source: "edition" })
    const ref = { grantId: grant.id, revision: 3 }
    await expect(resolveExecution(ref, "session.send", target, "user-1")).resolves.toEqual({ hold: expect.stringMatching(/no longer run/) })
    answer = localRequest()
    setRequestPrincipal(answer, { ...principal, userId: "intruder" })
    await expect(resolveExecution(ref, "session.send", target, "user-1")).resolves.toEqual({ hold: expect.stringMatching(/another account/) })
    answer = signedIn("unused")
    await expect(resolveExecution(ref, "session.send", target, "user-1")).resolves.toEqual({ req: answer })
    expect(unattended.resolve).toHaveBeenLastCalledWith({ ...ref, action: "session.send", target })
    await revokeExecutionGrant(grant.id, "Account disabled")
    expect(unattended.revoke).toHaveBeenCalledWith("edition-grant-1")
    // A personal grant stops working once the server signs accounts in.
    __resetEditionForTest()
    const personal = await issueExecutionGrant(localRequest(), { actions: ["session.send"], target, label: "x" }, "local")
    useAccountSignIn()
    await expect(resolveExecution({ grantId: personal.id, revision: 1 }, "session.send", target, "local")).resolves.toEqual({ hold: expect.stringMatching(/sign-in changed/) })
  })
})

function harness(executor: Partial<TriggerExecutor> = {}, prepare: (occurrence: TriggerOccurrence) => Promise<Prepared> = async () => ({ action: "session.send", target, request: { message: "continue" } })) {
  const dispatcher = commandDispatcher()
  const runner = new TriggerRunner(dispatcher, { ...defaultExecutor, ...executor })
  dispatcher.onTick((lease) => runner.tick(lease))
  const unregister = registerTriggerHandler("test", { prepare })
  afterEach(unregister)
  return { dispatcher, store: dispatcher.store, runner, unregister }
}

describe("the trigger runner", () => {
  it("sends due work under its grant through the durable queue, without the grant reaching the agent", async () => {
    let running = false
    const send = vi.fn(async () => { running = true; return { delivery: "started" as const, turnId: "turn-1" } })
    const runtime = { kind: "claude", instanceId: "default", descriptor: descriptorFor("claude"), activity: () => ({ live: true, running }), send } as unknown as AgentRuntime
    const { dispatcher, store, unregister } = harness({
      send: (claim, lease, prepared, req, durable) => admitOccurrenceCommand({ sessionId: prepared.target.sessionId, request: prepared.request, req, claim, lease, intent: "queue", runtime, binding, ...(durable && claim.occurrence.grant ? { executionGrant: claim.occurrence.grant } : {}) }),
    })
    try {
      const grant = await issueExecutionGrant(localRequest(), { actions: ["session.send"], target, label: "x" }, "local")
      const { occurrence } = store.recordOccurrence("local", { triggerId: "trigger-0001", kind: "test", key: "slot-1", dueAt: Date.now() + 60_000, action: "session.send", grant: { grantId: grant.id, revision: 1 }, request: {} })
      await dispatcher.tick()
      expect(store.occurrence("local", occurrence.id)!.state).toBe("scheduled")
      vi.setSystemTime(Date.now() + 60_000)
      await dispatcher.tick()
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
      expect(send.mock.calls[0]![1]).toMatchObject({ message: "continue", commandId: expect.any(String) })
      expect(send.mock.calls[0]![1]).not.toHaveProperty("executionGrant")
      expect(send.mock.calls[0]![1]).not.toHaveProperty("trigger")
      running = false
      await vi.waitFor(async () => {
        await dispatcher.tick()
        expect(store.occurrence("local", occurrence.id)).toMatchObject({ state: "completed", sessionId: "native-1" })
      })
    } finally { unregister() }
  })

  it("holds a command for reauthorization when its grant is revoked between admission and delivery", async () => {
    const send = vi.fn()
    const runtime = { kind: "claude", instanceId: "default", descriptor: descriptorFor("claude"), activity: () => ({ live: true, running: true }), send } as unknown as AgentRuntime
    const grant = await issueExecutionGrant(localRequest(), { actions: ["session.send"], target, label: "x" }, "local")
    const { dispatcher, store, unregister } = harness({
      send: async (claim, lease, prepared, req) => {
        const receipt = await admitOccurrenceCommand({ sessionId: prepared.target.sessionId, request: prepared.request, req, claim, lease, intent: "queue", runtime, binding, executionGrant: claim.occurrence.grant! })
        await revokeExecutionGrant(grant.id, "Owner revoked it")
        return receipt
      },
    })
    try {
      const { occurrence } = store.recordOccurrence("local", { triggerId: "trigger-0001", kind: "test", key: "slot-1", dueAt: Date.now(), action: "session.send", grant: { grantId: grant.id, revision: 1 }, request: {} })
      await dispatcher.tick()
      await vi.waitFor(async () => {
        await dispatcher.tick()
        expect(store.command("local", occurrence.commandId)?.receipt.state).toBe("held")
      })
      expect(send).not.toHaveBeenCalled()
    } finally { unregister() }
  })

  it("holds, retries with backoff and finally fails sends that never reached the queue", async () => {
    const failures: unknown[] = [new OrchestrationError(403, "Session access changed"), new Error("busy disk")]
    const { dispatcher, store, unregister } = harness({ send: async () => { throw failures.shift() ?? new Error("still failing") } })
    try {
      const grant = await issueExecutionGrant(localRequest(), { actions: ["session.send"], target, label: "x" }, "local")
      const ref = { grantId: grant.id, revision: 1 }
      const held = store.recordOccurrence("local", { triggerId: "trigger-held", kind: "test", key: "a", dueAt: Date.now(), action: "session.send", grant: ref, request: {} }).occurrence
      await dispatcher.tick()
      await vi.waitFor(() => expect(store.occurrence("local", held.id)).toMatchObject({ state: "held", hold: "reauthorize", reason: "Session access changed" }))
      const startedAt = Date.now()
      const retried = store.recordOccurrence("local", { triggerId: "trigger-retry", kind: "test", key: "b", dueAt: startedAt, action: "session.send", grant: ref, request: {} }).occurrence
      await dispatcher.tick()
      await vi.waitFor(() => expect(store.occurrence("local", retried.id)).toMatchObject({ state: "scheduled", reason: "busy disk" }))
      expect(store.occurrence("local", retried.id)!.dueAt).toBeGreaterThanOrEqual(startedAt + 60_000)
      for (let attempt = 2; attempt <= 5; attempt++) {
        vi.setSystemTime(store.occurrence("local", retried.id)!.dueAt)
        await dispatcher.tick()
        await vi.waitFor(() => expect(store.occurrence("local", retried.id)!.attempt).toBe(attempt))
        await vi.waitFor(() => expect(store.occurrence("local", retried.id)!.state).not.toBe("admitting"))
      }
      expect(store.occurrence("local", retried.id)).toMatchObject({ state: "failed", reason: expect.stringMatching(/Gave up after 5 attempts/) })
    } finally { unregister() }
  })

  it("settles session creation from its operation: started, unknown after it began, or failed before", async () => {
    const outcomes = ["started", "began-then-crashed", "refused"]
    const { dispatcher, store, unregister } = harness({
      create: async (claim) => {
        const outcome = outcomes.shift()
        if (outcome === "refused") throw new OrchestrationError(400, "Project folder is missing")
        dispatcher.store.beginOperation(claim.occurrence.scope, claim.occurrence.creationId, "hash", {})
        if (outcome === "began-then-crashed") throw new Error("agent exited")
        dispatcher.store.finishOperation(claim.occurrence.scope, claim.occurrence.creationId, { sessionId: "created-1" })
        return { sessionId: "created-1", dirName: "proj", fileName: "created-1.jsonl", filePath: "/p/created-1.jsonl" }
      },
    }, async () => ({ action: "session.create", target: { agent: "claude", instanceId: "default", dirName: "proj" }, input: { dirName: "proj", message: "nightly" } }))
    try {
      const grant = await issueExecutionGrant(localRequest(), { actions: ["session.create"], target: { agent: "claude", instanceId: "default", dirName: "proj" }, label: "x" }, "local")
      const ids = ["one", "two", "three"].map((key) => store.recordOccurrence("local", { triggerId: `trigger-${key}`, kind: "test", key, dueAt: Date.now(), action: "session.create", grant: { grantId: grant.id, revision: 1 }, request: {} }).occurrence.id)
      // One trigger at a time per tick order; each has its own trigger, so all three run.
      await dispatcher.tick()
      await vi.waitFor(() => expect(ids.map((id) => store.occurrence("local", id)!.state).sort()).toEqual(["completed", "failed", "unknown"]))
      const byState = Object.fromEntries(ids.map((id) => store.occurrence("local", id)!).map((occurrence) => [occurrence.state, occurrence]))
      expect(byState.completed).toMatchObject({ sessionId: "created-1" })
      expect(byState.unknown!.reason).toMatch(/A session may have started/)
      expect(byState.failed!.reason).toBe("Project folder is missing")
    } finally { unregister() }
  })

  it("lets a handler skip or hold, and holds work without a grant", async () => {
    const decisions: Prepared[] = [{ skip: "Previous run still active" }, { hold: "review", reason: "Missed while the host was off" }]
    const { dispatcher, store, unregister } = harness({}, async () => decisions.shift() ?? { action: "session.send", target, request: { message: "x" } })
    try {
      const ids = ["a", "b", "c"].map((key) => store.recordOccurrence("local", { triggerId: `trigger-${key}`, kind: "test", key, dueAt: Date.now(), action: "session.send", grant: null, request: {} }).occurrence.id)
      await dispatcher.tick()
      await vi.waitFor(() => expect(ids.map((id) => store.occurrence("local", id)!.state)).toEqual(["skipped", "held", "held"]))
      expect(store.occurrence("local", ids[1]!)!.hold).toBe("review")
      expect(store.occurrence("local", ids[2]!)).toMatchObject({ hold: "reauthorize", reason: expect.stringMatching(/reauthorized by its owner/) })
    } finally { unregister() }
  })

  it("runs a held occurrence once as a live sign-in, and holds it again once that sign-in expired", async () => {
    useAccountSignIn()
    const token = createSessionToken("127.0.0.1", undefined, principal)
    const sent = vi.fn<TriggerExecutor["send"]>(async (claim, lease) => { commandDispatcher().store.finishOccurrence(claim, lease, "completed"); return null })
    const { dispatcher, store, runner, unregister } = harness({ send: sent })
    try {
      const grant = await issueExecutionGrant(signedIn(token), { actions: ["session.send"], target, label: "x" }, "user-1")
      const ref = { grantId: grant.id, revision: 1 }
      const { occurrence } = store.recordOccurrence("user-1", { triggerId: "trigger-0001", kind: "test", key: "a", dueAt: Date.now(), action: "session.send", grant: ref, request: {} })
      await dispatcher.tick()
      await vi.waitFor(() => expect(store.occurrence("user-1", occurrence.id)!.state).toBe("held"))
      expect(() => runner.reauthorizeLive(localRequest(), "user-1", occurrence.id)).toThrow()
      runner.reauthorizeLive(signedIn(token), "user-1", occurrence.id)
      await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1))
      expect(sent.mock.calls[0]![4]).toBe(false)
      await vi.waitFor(() => expect(store.occurrence("user-1", occurrence.id)!.state).toBe("completed"))
      store.holdOccurrence("user-1", store.recordOccurrence("user-1", { triggerId: "trigger-0002", kind: "test", key: "b", dueAt: Date.now() + 3_600_000, action: "session.send", grant: ref, request: {} }).occurrence.id, "reauthorize", "x")
      const second = store.occurrences("user-1", "trigger-0002")[0]!
      await revokeSessionToken(token)
      runner.reauthorizeLive(signedIn(token), "user-1", second.id)
      await vi.waitFor(() => expect(store.occurrence("user-1", second.id)).toMatchObject({ state: "held", reason: expect.stringMatching(/expired/) }))
      expect(sent).toHaveBeenCalledTimes(1)
    } finally { unregister() }
  })
})
