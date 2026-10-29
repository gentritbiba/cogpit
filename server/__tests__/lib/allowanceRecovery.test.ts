// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import { appendFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import * as nativeIdentity from "../../agents/recoveryIdentity"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { RECOVERY_MESSAGE, recoveryDueAt } from "../../../shared/contracts/recovery"
import { cancelRecovery, initializeAllowanceRecovery, optInRecovery, prepareRecovery, reauthorizeRecovery, recoveryDeliveryGuard, recoveryStatus } from "../../lib/allowanceRecovery"
import { closeCommandDispatcher, commandDispatcher } from "../../lib/durableSend"
import { getRateLimit, publishRateLimit } from "../../lib/streamBus"
import * as streamBus from "../../lib/streamBus"
import { closeOrchestrationStore, orchestrationStore } from "../../orchestration/storage"
import { registerTriggerDeliveryGuard } from "../../orchestration/deliveryGuards"
import { __resetEditionForTest, PERSONAL_EDITION } from "../../edition"
import { installFakeEdition, useAccountSignIn } from "../edition/fakeEdition"
import { createSessionToken, __resetSessionsForTest } from "../../security"
import { setRequestAuthentication } from "../../requestAuthentication"
import { fakeEditionAuth } from "../edition/fakeAuth"
import { publishSessionCancellation } from "../../lib/sessionCancellation"
import { setRequestPrincipal } from "../../requestPrincipal"
import { triggerScheduler } from "../../lib/triggers/runner"
import { revokeExecutionGrant } from "../../lib/triggers/authority"
import type { AgentRuntime } from "../../agents/runtimeTypes"

const mocks = vi.hoisted(() => ({
  filePath: "", running: false, approvals: [] as unknown[], archived: new Map<string, number>(), kept: new Set<string>(),
  archiveListeners: [] as Array<(ids: readonly string[]) => void>,
  send: vi.fn(), resolve: vi.fn(), runtime: {} as AgentRuntime,
}))
vi.mock("../../agents/runtimes", () => ({
  resolveSessionAgent: (...args: unknown[]) => mocks.resolve(...args),
  runtimeFor: () => mocks.runtime,
}))
vi.mock("../../lib/sessionArchive", async (original) => ({
  ...await original<object>(),
  readArchive: async () => ({ archived: mocks.archived, kept: mocks.kept }),
  subscribeSessionArchive: (listener: (ids: readonly string[]) => void) => { mocks.archiveListeners.push(listener); return () => {} },
  setSessionsArchived: async () => [],
}))
const SESSION = "12345678-1111-2222-3333-444444444444"
const req = () => new IncomingMessage(new Socket())
const block = () => ({ limit: "five_hour", resetsAt: (Date.now() + 60_000) / 1000, lowPriority: true })
let root: string
let request: IncomingMessage

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_800_000_000_000)
  root = await mkdtemp(join(tmpdir(), "recovery-native-"))
  mocks.filePath = join(root, `${SESSION}.jsonl`)
  await writeFile(mocks.filePath, JSON.stringify({ type: "user", uuid: "blocked-prompt", message: { role: "user", content: "Finish the task" } }) + "\n")
  mocks.running = false; mocks.approvals = []; mocks.archived.clear(); mocks.kept.clear(); mocks.kept.add(SESSION)
  mocks.send.mockReset().mockResolvedValue({ delivery: "started", completion: Promise.resolve({ isError: false }) })
  mocks.resolve.mockReset().mockImplementation(async () => ({ kind: "claude", instanceId: "default", filePath: mocks.filePath }))
  mocks.runtime = {
    kind: "claude", instanceId: "default", descriptor: descriptorFor("claude"),
    activity: () => ({ live: true, running: mocks.running, agentsRunning: false }),
    listPendingApprovals: () => mocks.approvals,
    listPendingQuestions: () => [], listPendingPlans: () => [], send: mocks.send,
  } as unknown as AgentRuntime
  request = req()
  initializeAllowanceRecovery()
  publishRateLimit(SESSION, null)
  await recoveryStatus(request, SESSION)
})
afterEach(async () => {
  await recoveryStatus(request, SESSION)
  closeCommandDispatcher(); closeOrchestrationStore(); __resetEditionForTest(); __resetSessionsForTest(); vi.restoreAllMocks(); vi.useRealTimers()
  registerTriggerDeliveryGuard("recovery", recoveryDeliveryGuard)
  await rm(root, { recursive: true, force: true })
})

async function consent() {
  publishRateLimit(SESSION, block())
  const offered = await recoveryStatus(request, SESSION)
  expect(offered.offer).not.toBeNull()
  return optInRecovery(request, SESSION, offered.offer!.id)
}
async function due() {
  vi.setSystemTime(Date.now() + 60_000)
  triggerScheduler()
  await commandDispatcher().tick()
}
async function runState(state: string) {
  await vi.waitFor(async () => {
    await commandDispatcher().tick()
    expect((await recoveryStatus(request, SESSION)).run?.state).toBe(state)
  })
}

it("converts future reset seconds exactly once and rejects invalid dates", () => {
  expect(recoveryDueAt(block())).toBe(Date.now() + 60_000)
  for (const resetsAt of [null, NaN, Infinity, -Infinity, 0, Date.now() / 1000, (Date.now() - 1) / 1000, Number.MAX_VALUE, Date.now()]) {
    expect(recoveryDueAt({ ...block(), resetsAt })).toBeNull()
  }
})

it("never schedules without consent or accepts a client-invented blocked identity", async () => {
  publishRateLimit(SESSION, block())
  expect((await recoveryStatus(request, SESSION)).offer).not.toBeNull()
  await expect(optInRecovery(request, SESSION, "invented-reset")).rejects.toMatchObject({ status: 409 })
  await due()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(orchestrationStore().triggers(null, "recovery")).toEqual([])
})

it("dispatches once at the due time through the durable send pipeline", async () => {
  const scheduled = await consent()
  expect(scheduled.run).toMatchObject({ state: "scheduled", dueAt: Date.now() + 60_000 })
  await commandDispatcher().tick()
  expect(mocks.send).not.toHaveBeenCalled()
  await due(); await runState("completed")
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.send.mock.calls[0]).toMatchObject([SESSION, { message: RECOVERY_MESSAGE, commandId: expect.any(String) }])
  expect(mocks.send.mock.calls[0]![1]).not.toHaveProperty("executionGrant")
  await commandDispatcher().tick(); await commandDispatcher().tick()
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it("deduplicates repeated callbacks and simultaneous opt-in requests", async () => {
  const report = block(); publishRateLimit(SESSION, report)
  const offered = await recoveryStatus(request, SESSION)
  publishRateLimit(SESSION, { ...report })
  const [first, second] = await Promise.all([optInRecovery(request, SESSION, offered.offer!.id), optInRecovery(request, SESSION, offered.offer!.id)])
  expect(first.run?.id).toBe(second.run?.id)
  expect(orchestrationStore().openOccurrences("local", orchestrationStore().triggers("local", "recovery")[0]!.id)).toHaveLength(1)
  await due(); await runState("completed")
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it("persists opt-in across restart and restores the same command identity", async () => {
  const scheduled = await consent()
  const saved = orchestrationStore().occurrence("local", scheduled.run!.id)!
  closeOrchestrationStore()
  vi.spyOn(streamBus, "getRateLimit").mockReturnValue(null)
  expect((await recoveryStatus(request, SESSION)).run?.id).toBe(saved.id)
  await due(); await runState("completed")
  expect(orchestrationStore().occurrence("local", saved.id)?.commandId).toBe(saved.commandId)
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it("repairs a restart after consent persistence but before occurrence recording", async () => {
  const scheduled = await consent()
  const store = orchestrationStore()
  const record = store.triggers("local", "recovery")[0]!
  // A definition is durable even if a crash prevents its first occurrence.
  const isolated = store.putTrigger("local", { ...record, id: "recovery-repair", data: { ...record.data, offer: { ...(record.data.offer as object), id: "repair-key" } } })
  closeOrchestrationStore()
  triggerScheduler()
  await commandDispatcher().tick()
  expect(orchestrationStore().openOccurrences("local", isolated.id)).toHaveLength(1)
  expect(scheduled.run?.state).toBe("scheduled")
})

it("cancels consent durably and cannot reactivate it by replaying opt-in", async () => {
  await consent()
  const observed = orchestrationStore().triggers("recovery-observations", "recovery-block")[0]!
  await cancelRecovery(request, SESSION)
  closeOrchestrationStore()
  const retried = await optInRecovery(request, SESSION, (observed.data.offer as { id: string }).id)
  expect(retried.run?.state).toBe("cancelled")
  expect(retried.offer).toBeNull()
  await due(); expect(mocks.send).not.toHaveBeenCalled()
})

it.each([null, NaN, Infinity, 0, 1_700_000_000])("does not offer invalid/expired reset %s", async (resetsAt) => {
  publishRateLimit(SESSION, { ...block(), resetsAt })
  expect((await recoveryStatus(request, SESSION)).offer).toBeNull()
})

it("expires an unaccepted offer without looping and rejects generic provider errors", async () => {
  expect(getRateLimit(SESSION)).toBeNull()
  expect((await recoveryStatus(request, SESSION)).offer).toBeNull()
  publishRateLimit(SESSION, block())
  const offered = await recoveryStatus(request, SESSION)
  await due()
  await expect(optInRecovery(request, SESSION, offered.offer!.id)).rejects.toMatchObject({ status: 409 })
  expect((await recoveryStatus(request, SESSION)).offer).toBeNull()
  expect(mocks.send).not.toHaveBeenCalled()
})

it("new manual work fences recovery before due dispatch", async () => {
  const scheduled = await consent()
  const store = orchestrationStore()
  const record = store.triggers("local", "recovery")[0]!
  store.admit("local", "manual-work-1", record.data.conversationId as string, { message: "Do something else" })
  expect(store.occurrence("local", scheduled.run!.id)?.state).toBe("cancelled")
  await due(); expect(mocks.send).not.toHaveBeenCalled()
})

it.each(["native", "running", "approval", "archive", "binding", "provider", "deleted", "unblocked"])("invalidates recovery after %s changes", async (change) => {
  await consent()
  if (change === "native") await appendFile(mocks.filePath, JSON.stringify({ type: "user", uuid: "external-work", message: { role: "user", content: "New native task" } }) + "\n")
  if (change === "running") mocks.running = true
  if (change === "approval") mocks.approvals = [{}]
  if (change === "archive") { mocks.archived.set(SESSION, Date.now()); for (const listener of mocks.archiveListeners) listener([SESSION]) }
  if (change === "binding") { const record = orchestrationStore().triggers("local", "recovery")[0]!; const current = orchestrationStore().conversation(record.data.conversationId as string)!; orchestrationStore().transition(current.id, current.revision, { ...current.binding, instanceId: "other" }) }
  if (change === "provider") mocks.resolve.mockResolvedValue({ kind: "claude", instanceId: "another", filePath: mocks.filePath })
  if (change === "deleted") mocks.resolve.mockRejectedValue(new Error("Session deleted"))
  if (change === "unblocked") { publishRateLimit(SESSION, null); await recoveryStatus(request, SESSION) }
  await due()
  await vi.waitFor(async () => expect(["cancelled", "skipped"]).toContain((await recoveryStatus(request, SESSION)).run?.state))
  expect(mocks.send).not.toHaveBeenCalled()
})

it("does not mistake assistant trailing output for new user work", async () => {
  await consent()
  await appendFile(mocks.filePath, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Usage exhausted" }] } }) + "\n")
  await due(); await runState("completed")
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it("holds a revoked grant without sending and reauthorizes the same occurrence", async () => {
  const scheduled = await consent()
  const run = orchestrationStore().occurrence("local", scheduled.run!.id)!
  await revokeExecutionGrant(run.grant!.grantId, "Owner revoked it")
  await due(); await runState("held")
  expect(mocks.send).not.toHaveBeenCalled()
  await reauthorizeRecovery(request, SESSION)
  await runState("completed")
  expect((await recoveryStatus(request, SESSION)).run?.id).toBe(run.id)
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it("denies an opt-in if session access is lost while issuing the grant", async () => {
  publishRateLimit(SESSION, block())
  const offered = await recoveryStatus(request, SESSION)
  installFakeEdition({ access: { ...PERSONAL_EDITION.access, levelOf: async () => "view" } })
  await expect(optInRecovery(request, SESSION, offered.offer!.id)).rejects.toMatchObject({ status: 403 })
  expect(orchestrationStore().triggers("local", "recovery")[0]).toMatchObject({ state: "paused", grant: null, data: { consent: "denied" } })
  expect((await recoveryStatus(request, SESSION)).run).toBeNull()
})

it("holds an authenticated edition without durable authority after restart", async () => {
  useAccountSignIn()
  setRequestPrincipal(request, { userId: "owner", username: "owner", role: "member" })
  const scheduled = await consent()
  closeOrchestrationStore()
  await due(); await runState("held")
  expect((await recoveryStatus(request, SESSION)).support).toBe("none")
  expect(orchestrationStore().occurrence("owner", scheduled.run!.id)?.hold).toBe("reauthorize")
  expect(mocks.send).not.toHaveBeenCalled()
})

it("holds a missing guard after restart and resumes the same durable command", async () => {
  const scheduled = await consent()
  const run = orchestrationStore().occurrence("local", scheduled.run!.id)!
  const store = orchestrationStore()
  const dispatcher = commandDispatcher()
  const lease = store.acquire("test", 1)
  // The dispatcher owns the lease; use its runner to prepare normally below.
  expect(lease).toBeNull()
  const unregister = registerTriggerDeliveryGuard("recovery", recoveryDeliveryGuard); unregister()
  await due(); await runState("held")
  expect((await recoveryStatus(request, SESSION)).run?.reason).toMatch(/delivery check/)
  registerTriggerDeliveryGuard("recovery", recoveryDeliveryGuard)
  await reauthorizeRecovery(request, SESSION)
  await dispatcher.tick(); await runState("completed")
  expect(orchestrationStore().occurrence("local", run.id)?.commandId).toBe(run.commandId)
})

it("prepare refuses an early dispatch even if called directly", async () => {
  const scheduled = await consent()
  expect(await prepareRecovery(orchestrationStore().occurrence("local", scheduled.run!.id)!)).toHaveProperty("skip")
})

async function admitted() {
  const scheduled = await consent()
  const store = orchestrationStore()
  const run = store.occurrence("local", scheduled.run!.id)!
  const definition = store.triggers("local", "recovery")[0]!
  closeCommandDispatcher()
  vi.setSystemTime(run.dueAt)
  const lease = store.acquire("synthetic-admission")!
  const claim = store.claimOccurrences(lease, ["recovery"])[0]!
  store.admitForOccurrence(claim, lease, definition.data.conversationId as string, { message: RECOVERY_MESSAGE, filePath: mocks.filePath, executionGrant: run.grant }, "queue", 1)
  store.release(lease)
  expect(store.occurrence("local", run.id)?.state).toBe("admitted")
  return { store, run }
}

it.each(["native", "running", "approval", "archive", "optout", "manual", "stop"])("blocks %s appearing AFTER admission before provider delivery", async (change) => {
  const { store, run } = await admitted()
  if (change === "native") await appendFile(mocks.filePath, JSON.stringify({ type: "user", uuid: "after-admission", message: { role: "user", content: "A task started in the terminal" } }) + "\n")
  if (change === "running") mocks.running = true
  if (change === "approval") mocks.approvals = [{}]
  if (change === "archive") { mocks.archived.set(SESSION, Date.now()); for (const listener of mocks.archiveListeners) listener([SESSION]) }
  if (change === "optout") await cancelRecovery(request, SESSION)
  if (change === "manual") store.admit("local", "after-admission-user", store.occurrence("local", run.id)!.command!.conversationId, { message: "New manual task" })
  if (change === "stop") store.cancelWaiting(store.occurrence("local", run.id)!.command!.conversationId)
  triggerScheduler()
  await runState("cancelled")
  expect(mocks.send.mock.calls.some(([, request]) => request.message === RECOVERY_MESSAGE)).toBe(false)
  expect(store.occurrence("local", run.id)?.command?.state).toBe("cancelled")
})

it("renews revoked post-admission authority without changing the command or fingerprint", async () => {
  const { store, run } = await admitted()
  const original = store.command("local", run.commandId)!
  await revokeExecutionGrant(run.grant!.grantId, "Revoked after admission")
  triggerScheduler(); await runState("held")
  expect((await recoveryStatus(request, SESSION)).run?.hold).toBe("reauthorize")
  await reauthorizeRecovery(request, SESSION); await runState("completed")
  const delivered = store.command("local", run.commandId)!
  expect(delivered.fingerprint).toBe(original.fingerprint)
  expect(delivered.payload).toEqual(original.payload)
  expect(store.occurrence("local", run.id)?.grant?.grantId).not.toBe(run.grant?.grantId)
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it("leaves an unknown native outcome visible after restart and never resends it", async () => {
  const scheduled = await consent()
  mocks.send.mockRejectedValue(new Error("Connection lost after possible provider acceptance"))
  await due(); await runState("unknown")
  closeOrchestrationStore(); triggerScheduler()
  await commandDispatcher().tick()
  expect((await recoveryStatus(request, SESSION)).run).toMatchObject({ id: scheduled.run!.id, state: "unknown", command: { state: "unknown" } })
  await expect(reauthorizeRecovery(request, SESSION)).rejects.toMatchObject({ status: 409 })
  expect(mocks.send).toHaveBeenCalledTimes(1)
})

it("cancellation wins while the edition is issuing authority", async () => {
  publishRateLimit(SESSION, block())
  const offer = (await recoveryStatus(request, SESSION)).offer!
  let allow: (value: "interact") => void = () => {}
  installFakeEdition({ access: { ...PERSONAL_EDITION.access, levelOf: () => new Promise((resolve) => { allow = resolve }) } })
  const enabling = optInRecovery(request, SESSION, offer.id)
  await vi.waitFor(() => expect(orchestrationStore().triggers("local", "recovery")[0]?.data.consent).toBe("authorizing"))
  await cancelRecovery(request, SESSION)
  allow("interact")
  await expect(enabling).rejects.toMatchObject({ status: 409 })
  expect((await recoveryStatus(request, SESSION)).offer).toBeNull()
  await due(); expect(mocks.send).not.toHaveBeenCalled()
})

it("explicitly reauthorizes an edition without unattended support using an active live sign-in", async () => {
  useAccountSignIn()
  const principal = { userId: "owner", username: "owner", role: "member" }
  const token = createSessionToken("127.0.0.1", undefined, principal)
  setRequestPrincipal(request, principal)
  setRequestAuthentication(request, { kind: "session", token, principal })
  const scheduled = await consent()
  await due(); await runState("held")
  await reauthorizeRecovery(request, SESSION); await runState("completed")
  const run = orchestrationStore().occurrence("owner", scheduled.run!.id)!
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(JSON.stringify([run, orchestrationStore().command("owner", run.commandId)])).not.toContain(token)
})

it.each([true, false])("restores an edition grant after restart and rechecks access (%s)", async (allowed) => {
  const principal = { userId: "owner", username: "owner", role: "member" }
  let authorized = true
  installFakeEdition({ auth: fakeEditionAuth(), unattended: {
    issue: async () => ({ grantId: "edition-recovery-grant", revision: 1 }),
    resolve: async () => { if (!authorized) return null; const resolved = req(); setRequestPrincipal(resolved, principal); return resolved },
    revoke: async () => {},
  } })
  setRequestPrincipal(request, principal)
  await consent(); closeOrchestrationStore(); authorized = allowed
  await due(); await runState(allowed ? "completed" : "held")
  expect(mocks.send).toHaveBeenCalledTimes(allowed ? 1 : 0)
})

it.each([SESSION, null])("stop signal %s invalidates persisted consent", async (sessionId) => {
  await consent()
  publishSessionCancellation(sessionId)
  expect((await recoveryStatus(request, SESSION)).run?.state).toBe("cancelled")
  closeOrchestrationStore(); await due()
  expect(mocks.send).not.toHaveBeenCalled()
})

it("captures the user-activity fence before asynchronous block observation", async () => {
  const store = orchestrationStore()
  const conversation = store.ensureConversation({ hostId: "local", agent: "claude", instanceId: "default", sessionId: SESSION, filePath: mocks.filePath })
  let release: (value: unknown) => void = () => {}
  mocks.resolve.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  publishRateLimit(SESSION, block())
  await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalled())
  store.admit("local", "raced-observation", conversation.id, { message: "New work while observing" })
  release({ kind: "claude", instanceId: "default", filePath: mocks.filePath })
  expect((await recoveryStatus(request, SESSION)).offer).toBeNull()
})

it("honors automatic archival before a distant reset", async () => {
  await consent()
  mocks.kept.clear()
  const old = new Date(Date.now() - 15 * 24 * 60 * 60_000)
  await utimes(mocks.filePath, old, old)
  await due(); await runState("skipped")
  expect((await recoveryStatus(request, SESSION)).run?.reason).toMatch(/archived/)
  expect(mocks.send).not.toHaveBeenCalled()
})

it("cancels for durable pending input even if the restarted runtime has no in-memory questions", async () => {
  await consent()
  orchestrationStore().putQuestion({ instanceId: "default", sessionId: SESSION, requestId: "pending-native-question", data: {} })
  closeOrchestrationStore()
  await due()
  await vi.waitFor(async () => expect(["cancelled", "skipped"]).toContain((await recoveryStatus(request, SESSION)).run?.state))
  expect(mocks.send).not.toHaveBeenCalled()
})

it("keeps an existing uncertain native delivery visible instead of offering another continuation", async () => {
  const store = orchestrationStore()
  const conversation = store.ensureConversation({ hostId: "local", agent: "claude", instanceId: "default", sessionId: SESSION, filePath: mocks.filePath })
  const lease = store.acquire("uncertain-delivery")!
  store.admit("local", "uncertain-native-turn", conversation.id, { message: "Original task" })
  const claim = store.claim("local", "uncertain-native-turn", lease)!
  store.finish(claim, lease, "unknown", { error: "Provider acceptance is uncertain" })
  store.release(lease)
  publishRateLimit(SESSION, block())
  expect((await recoveryStatus(request, SESSION)).offer).toBeNull()
  expect(store.command("local", "uncertain-native-turn")?.receipt.state).toBe("unknown")
})

it.each(["optout", "approval", "binding", "manual"])("rechecks %s changing during the asynchronous native delivery guard", async (change) => {
  const { store, run } = await admitted()
  const fingerprint = await nativeIdentity.recoveryIdentity(mocks.filePath, "claude")
  let release: (value: string) => void = () => {}
  const reading = vi.spyOn(nativeIdentity, "recoveryIdentity").mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  const checking = recoveryDeliveryGuard(store.occurrence("local", run.id)!)
  await vi.waitFor(() => expect(reading).toHaveBeenCalled())
  if (change === "optout") await cancelRecovery(request, SESSION)
  if (change === "approval") mocks.approvals = [{}]
  if (change === "binding") { const current = store.conversation(store.occurrence("local", run.id)!.command!.conversationId)!; store.transition(current.id, current.revision, { ...current.binding, instanceId: "changed" }) }
  if (change === "manual") store.admit("local", "during-native-check", store.occurrence("local", run.id)!.command!.conversationId, { message: "New task" })
  release(fingerprint)
  await expect(checking).resolves.toMatchObject({ allow: false, disposition: "cancelled" })
  expect(mocks.send).not.toHaveBeenCalled()
})

it("holds the same command when its grant is revoked during the final native guard", async () => {
  const { store, run } = await admitted()
  let finalHandoff = false
  let revoked = false
  installFakeEdition({ turns: {
    ...PERSONAL_EDITION.turns,
    send: (_req, runtime, sessionId, input) => { finalHandoff = true; return runtime.send(sessionId, input) },
  } })
  const readIdentity = nativeIdentity.recoveryIdentity
  vi.spyOn(nativeIdentity, "recoveryIdentity").mockImplementation(async (...args) => {
    const fingerprint = await readIdentity(...args)
    if (finalHandoff && !revoked) { revoked = true; await revokeExecutionGrant(run.grant!.grantId, "Revoked during final native scan") }
    return fingerprint
  })
  triggerScheduler(); await runState("held")
  expect(revoked).toBe(true)
  expect((await recoveryStatus(request, SESSION)).run).toMatchObject({ id: run.id, hold: "reauthorize", command: { id: run.commandId, state: "held" } })
  expect(store.command("local", run.commandId)?.receipt.error).toMatch(/Revoked during final native scan/)
  expect(mocks.send).not.toHaveBeenCalled()
})
