import { createHash, randomUUID } from "node:crypto"
import type { IncomingMessage } from "node:http"
import { RECOVERY_MESSAGE, recoveryDueAt, type RecoveryOffer, type RecoveryStatus } from "../../shared/contracts/recovery"
import { isTerminalOccurrence } from "../../shared/contracts/triggers"
import type { ExecutionTarget, TriggerOccurrence, TriggerRecord } from "../../shared/contracts/triggers"
import { splitInstanceSessionId } from "../../shared/session/instances"
import type { RateLimitBlock } from "../../shared/session/rateLimit"
import { nativeBinding } from "../agents/nativeBindings"
import { statTranscript } from "../agents/transcriptFile"
import { recoveryIdentity } from "../agents/recoveryIdentity"
import { resolveSessionAgent, runtimeFor } from "../agents/runtimes"
import { registerTriggerDeliveryGuard, type DeliveryVerdict } from "../orchestration/deliveryGuards"
import { orchestrationStore } from "../orchestration/storage"
import { OrchestrationError } from "../orchestration/store"
import { commandScope } from "./durableSend"
import { subscribeSessionCancellation } from "./sessionCancellation"
import { archiveReason, readArchive, subscribeSessionArchive } from "./sessionArchive"
import { getRateLimit, subscribeRateLimits } from "./streamBus"
import { issueExecutionGrant, revokeExecutionGrant, unattendedSupport } from "./triggers/authority"
import { registerTriggerHandler, triggerScheduler, type Prepared } from "./triggers/runner"

const KIND = "recovery"
const OBSERVATIONS = "recovery-observations"
const OBSERVATION_KIND = "recovery-block"
type RecoveryTarget = ExecutionTarget & { sessionId: string; bindingRevision: number }
interface BlockIdentity extends Record<string, unknown> {
  offer: RecoveryOffer
  target: RecoveryTarget
  conversationId: string
  nativeIdentity: string
  filePath: string
  eventCursor: number
  consent?: "authorizing" | "enabled" | "dismissed" | "denied"
}
const consentRequests = new Map<string, Promise<RecoveryStatus>>()
const pending = new Map<string, Promise<void>>()
const idFor = (sessionId: string) => `recovery-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`
const sameBlock = (a: RateLimitBlock, b: RateLimitBlock) => a.limit === b.limit && a.resetsAt === b.resetsAt

function observation(sessionId: string): TriggerRecord | null { return orchestrationStore().trigger(OBSERVATIONS, idFor(sessionId)) }
function identity(record: TriggerRecord): BlockIdentity { return record.data as BlockIdentity }
function ref(grant: { id: string; revision: number }) { return { grantId: grant.id, revision: grant.revision } }

function invalidate(record: TriggerRecord, reason: string): void {
  const store = orchestrationStore()
  if (record.grant && !store.grant(record.grant.grantId)?.revokedAt) void revokeExecutionGrant(record.grant.grantId, reason)
  for (const run of store.openOccurrences(record.scope, record.id)) {
    try { store.cancelOccurrence(record.scope, run.id, reason) } catch (error) {
      // Admission/delivery has begun; revoked authority prevents any later send.
      if (!(error instanceof OrchestrationError) || error.status !== 409) throw error
    }
  }
  if (identity(record).consent !== "dismissed") store.putTrigger(record.scope, { ...record, state: "paused", data: { ...record.data, consent: "dismissed" } }, record.revision)
}

function invalidateSession(sessionId: string, reason: string, block?: RateLimitBlock): void {
  for (const record of orchestrationStore().triggers(null, KIND)) {
    const data = identity(record)
    if (data.target.sessionId === sessionId && (!block || !sameBlock(data.offer.block, block))) invalidate(record, reason)
  }
}

async function observe(sessionId: string, block: RateLimitBlock | null, eventCursor: number): Promise<void> {
  const store = orchestrationStore()
  const old = observation(sessionId)
  if (!block || recoveryDueAt(block) === null) {
    if (old) store.putTrigger(OBSERVATIONS, { ...old, state: "paused" }, old.revision)
    return
  }
  const resolved = await resolveSessionAgent(sessionId)
  if (!resolved.filePath) return
  const conversation = store.ensureConversation(await nativeBinding(sessionId, resolved.kind, resolved.filePath))
  if (conversation.binding.sessionId !== sessionId) return
  const nativeIdentity = await recoveryIdentity(resolved.filePath, resolved.kind)
  const dueAt = recoveryDueAt(block)
  if (dueAt === null || getRateLimit(sessionId) !== block) return
  const data: BlockIdentity = {
    offer: { id: randomUUID(), block, dueAt },
    target: { agent: resolved.kind, instanceId: resolved.instanceId ?? "default", sessionId, bindingRevision: conversation.revision },
    conversationId: conversation.id, nativeIdentity, filePath: resolved.filePath, eventCursor,
  }
  const current = observation(sessionId)
  store.putTrigger(OBSERVATIONS, { id: idFor(sessionId), kind: OBSERVATION_KIND, state: "active", grant: null, nextDueAt: null, data }, current?.revision)
}

async function settledObservation(sessionId: string): Promise<TriggerRecord | null> {
  await pending.get(sessionId)
  return observation(sessionId)
}

function conversationReason(data: BlockIdentity, allowedCommandId?: string): string | null {
  const store = orchestrationStore()
  const current = store.conversation(data.conversationId)
  if (!current || current.revision !== data.target.bindingRevision || current.binding.sessionId !== data.target.sessionId || current.binding.agent !== data.target.agent || current.binding.instanceId !== data.target.instanceId) return "The session's provider binding changed"
  const events = store.events(data.conversationId, data.eventCursor)
  if (events.reset || events.hasMore || events.events.some((event) => event.type === "command" && (event.data as { id?: string }).id !== allowedCommandId)) return "New conversation activity replaced the blocked turn"
  if (store.pending().some((command) => command.receipt.conversationId === data.conversationId && command.receipt.id !== allowedCommandId && ["held", "unknown"].includes(command.receipt.state))) return "Review held or uncertain delivery in the session queue"
  return null
}

function inputReason(data: BlockIdentity, runtime: ReturnType<typeof runtimeFor>): string | null {
  if (orchestrationStore().questions(data.target.instanceId, splitInstanceSessionId(data.target.sessionId).nativeId).length || runtime.listPendingApprovals(data.target.sessionId).length || runtime.listPendingQuestions(data.target.sessionId).length || runtime.listPendingPlans?.(data.target.sessionId).length) return "The session is waiting for approval or input"
  if (runtime.activity(data.target.sessionId).running) return "New work is running in this session"
  const block = getRateLimit(data.target.sessionId)
  return block && !sameBlock(block, data.offer.block) ? "The provider reported a different usage limit" : null
}

async function unavailable(data: BlockIdentity, checkNative: boolean, allowedCommandId?: string): Promise<string | null> {
  const initial = conversationReason(data, allowedCommandId)
  if (initial) return initial
  const archive = await readArchive()
  if (archive.archived.has(data.target.sessionId) || checkNative && archiveReason(archive, data.target.sessionId, (await statTranscript(data.filePath)).mtimeMs)) return "The session was archived"
  const resolved = await resolveSessionAgent(data.target.sessionId)
  if (resolved.kind !== data.target.agent || (resolved.instanceId ?? "default") !== data.target.instanceId || resolved.filePath !== data.filePath) return "The session's provider instance or transcript changed"
  const runtime = runtimeFor(resolved.kind, resolved.instanceId)
  const input = inputReason(data, runtime)
  if (input) return input
  if (checkNative && await recoveryIdentity(data.filePath, data.target.agent) !== data.nativeIdentity) return "New user work or native history changes replaced the blocked turn"
  return conversationReason(data, allowedCommandId) ?? inputReason(data, runtime)
}

export async function recoveryStatus(req: IncomingMessage, sessionId: string): Promise<RecoveryStatus> {
  const store = orchestrationStore()
  const scope = commandScope(req)
  const observed = await settledObservation(sessionId)
  const consent = store.trigger(scope, idFor(sessionId))
  const run = consent ? store.occurrences(scope, idFor(sessionId)).find((run) => run.key === identity(consent).offer.id) : undefined
  let offer: RecoveryOffer | null = null
  if (observed?.state === "active") {
    const data = identity(observed)
    if (recoveryDueAt(data.offer.block) !== null && (!consent || identity(consent).offer.id !== data.offer.id || ["authorizing", "denied"].includes(identity(consent).consent ?? "")) && !await unavailable(data, true)) offer = data.offer
  }
  return {
    offer,
    run: !offer && run ? { id: run.id, block: identity(consent!).offer.block, state: run.state, dueAt: run.dueAt, hold: run.hold, reason: run.reason, command: run.command } : null,
    support: unattendedSupport(), message: RECOVERY_MESSAGE,
  }
}

export async function optInRecovery(req: IncomingMessage, sessionId: string, offerId: unknown): Promise<RecoveryStatus> {
  const key = JSON.stringify([commandScope(req), sessionId, offerId])
  const pending = consentRequests.get(key)
  if (pending) return pending
  const request = enableRecovery(req, sessionId, offerId)
  consentRequests.set(key, request)
  try { return await request } finally { if (consentRequests.get(key) === request) consentRequests.delete(key) }
}

async function enableRecovery(req: IncomingMessage, sessionId: string, offerId: unknown): Promise<RecoveryStatus> {
  const store = orchestrationStore()
  const scope = commandScope(req)
  const observed = await settledObservation(sessionId)
  if (observed?.state !== "active" || identity(observed).offer.id !== offerId) throw new OrchestrationError(409, "This usage-limit offer changed; refresh the session")
  const data = identity(observed)
  const old = store.trigger(scope, idFor(sessionId))
  if (old && identity(old).offer.id === offerId && ["enabled", "dismissed"].includes(identity(old).consent ?? "")) return recoveryStatus(req, sessionId)
  if (recoveryDueAt(data.offer.block) === null) throw new OrchestrationError(409, "The provider reset must still be in the future")
  const reason = await unavailable(data, true)
  if (reason) throw new OrchestrationError(409, reason)
  if (old) invalidate(old, "A newer recovery offer replaced this consent")
  const latest = store.trigger(scope, idFor(sessionId))
  const intent = store.putTrigger(scope, { id: idFor(sessionId), kind: KIND, state: "paused", grant: null, nextDueAt: null, data: { ...data, consent: "authorizing" } }, latest?.revision)
  let grant: Awaited<ReturnType<typeof issueExecutionGrant>> | undefined
  try {
    grant = await issueExecutionGrant(req, { actions: ["session.send"], target: data.target, label: "Resume once after the usage limit resets" }, scope)
    if (observation(sessionId)?.revision !== observed.revision || recoveryDueAt(data.offer.block) === null || store.trigger(scope, intent.id)?.revision !== intent.revision) throw new OrchestrationError(409, "The blocked turn or consent changed while authorizing recovery")
    const changed = await unavailable(data, true)
    if (changed) throw new OrchestrationError(409, changed)
    store.putTrigger(scope, { ...intent, state: "active", grant: ref(grant), data: { ...data, consent: "enabled" } }, intent.revision)
    store.recordOccurrence(scope, { triggerId: idFor(sessionId), kind: KIND, key: data.offer.id, dueAt: data.offer.dueAt, action: "session.send", grant: ref(grant), request: { offerId: data.offer.id }, guarded: true, fence: { conversationId: data.conversationId } })
  } catch (error) {
    if (grant) await revokeExecutionGrant(grant.id, "Recovery consent was not recorded")
    if (store.trigger(scope, intent.id)?.revision === intent.revision) store.putTrigger(scope, { ...intent, data: { ...data, consent: "denied" } }, intent.revision)
    throw error
  }
  triggerScheduler().wake()
  return recoveryStatus(req, sessionId)
}

export async function cancelRecovery(req: IncomingMessage, sessionId: string): Promise<RecoveryStatus> {
  const record = orchestrationStore().trigger(commandScope(req), idFor(sessionId))
  if (record) invalidate(record, "Recovery consent was dismissed")
  return recoveryStatus(req, sessionId)
}

export async function reauthorizeRecovery(req: IncomingMessage, sessionId: string): Promise<RecoveryStatus> {
  const store = orchestrationStore()
  const scope = commandScope(req)
  const record = store.trigger(scope, idFor(sessionId))
  const run = record && store.openOccurrences(scope, record.id).find((run) => run.key === identity(record).offer.id)
  if (!record || record.state !== "active" || !run || run.state !== "held") throw new OrchestrationError(409, "Only a run held for authorization can be reauthorized here")
  const data = identity(record)
  const reason = await unavailable(data, true, run.commandId)
  if (reason) { invalidate(record, reason); throw new OrchestrationError(409, reason) }
  if (unattendedSupport() === "none") {
    triggerScheduler().reauthorizeLive(req, scope, run.id)
    return recoveryStatus(req, sessionId)
  }
  const grant = await issueExecutionGrant(req, { actions: ["session.send"], target: data.target, label: "Reauthorize usage-limit continuation" }, scope)
  if (store.trigger(scope, record.id)?.revision !== record.revision) {
    await revokeExecutionGrant(grant.id, "Consent changed during reauthorization")
    throw new OrchestrationError(409, "Consent changed; refresh recovery")
  }
  try {
    store.requeueOccurrence(scope, run.id, ref(grant))
    store.putTrigger(scope, { ...record, grant: ref(grant) }, record.revision)
  } catch (error) { await revokeExecutionGrant(grant.id, "Recovery could not be reauthorized"); throw error }
  if (record.grant) await revokeExecutionGrant(record.grant.grantId, "Replaced by renewed consent")
  triggerScheduler().wake()
  return recoveryStatus(req, sessionId)
}

export async function recoveryDeliveryGuard(run: TriggerOccurrence): Promise<DeliveryVerdict> {
  const record = orchestrationStore().trigger(run.scope, run.triggerId)
  if (!record || record.state !== "active" || identity(record).offer.id !== run.request.offerId) return { allow: false, disposition: "cancelled", reason: "Recovery consent is no longer active" }
  const reason = await unavailable(identity(record), true, run.commandId).catch(() => "The blocked session is no longer available")
  const current = orchestrationStore().trigger(run.scope, run.triggerId)
  if (current?.state !== "active" || current.revision !== record.revision) return { allow: false, disposition: "cancelled", reason: "Recovery consent changed before delivery" }
  return reason ? { allow: false, disposition: "cancelled", reason } : { allow: true }
}

export async function prepareRecovery(run: TriggerOccurrence): Promise<Prepared> {
  const record = orchestrationStore().trigger(run.scope, run.triggerId)
  if (!record || record.state !== "active" || identity(record).offer.id !== run.request.offerId) return { skip: "Recovery consent is no longer active" }
  const data = identity(record)
  if (!Number.isSafeInteger(data.offer.dueAt) || data.offer.dueAt > Date.now()) return { skip: "The provider reset is not due" }
  const reason = await unavailable(data, true, run.commandId).catch(() => "The blocked session is no longer available")
  if (orchestrationStore().trigger(run.scope, run.triggerId)?.revision !== record.revision) return { skip: "Recovery consent changed before admission" }
  if (reason) { invalidate(record, reason); return { skip: reason } }
  return { action: "session.send", target: data.target, request: { message: RECOVERY_MESSAGE, filePath: data.filePath }, intent: "queue" }
}

let initialized = false
export function initializeAllowanceRecovery(): void {
  if (initialized) return
  initialized = true
  registerTriggerDeliveryGuard(KIND, recoveryDeliveryGuard)
  registerTriggerHandler(KIND, {
    prepare: prepareRecovery,
    async record(store) {
      for (const record of store.triggers(null, KIND)) {
        if (record.state !== "active") continue
        const data = identity(record)
        const existing = store.occurrences(record.scope, record.id).find((run) => run.key === data.offer.id)
        if (existing && isTerminalOccurrence(existing.state)) {
          store.putTrigger(record.scope, { ...record, state: "paused" }, record.revision)
          if (record.grant) void revokeExecutionGrant(record.grant.grantId, "Recovery finished")
          continue
        }
        if (!existing?.command) {
          const reason = await unavailable(data, !existing).catch(() => "The blocked session is no longer available")
          if (store.trigger(record.scope, record.id)?.revision !== record.revision) continue
          if (reason) { invalidate(record, reason); continue }
        }
        if (existing) continue
        store.recordOccurrence(record.scope, { triggerId: record.id, kind: KIND, key: data.offer.id, dueAt: data.offer.dueAt, action: "session.send", grant: record.grant, request: { offerId: data.offer.id }, guarded: true, fence: { conversationId: data.conversationId } })
      }
    },
  })
  subscribeRateLimits((sessionId, block) => {
    invalidateSession(sessionId, "The provider's blocked turn changed", block ?? undefined)
    const observed = observation(sessionId)
    if (observed?.state === "active") orchestrationStore().putTrigger(OBSERVATIONS, { ...observed, state: "paused" }, observed.revision)
    // Event cursors are global, even when the queried conversation has no rows.
    const eventCursor = orchestrationStore().events("", 0).cursor
    const previous = pending.get(sessionId) ?? Promise.resolve()
    const next = previous.then(() => observe(sessionId, block, eventCursor)).catch(() => { /* Missing/deleted sessions cannot offer recovery. */ })
    pending.set(sessionId, next)
    void next.finally(() => { if (pending.get(sessionId) === next) pending.delete(sessionId) })
  })
  subscribeSessionCancellation((sessionId) => {
    for (const record of orchestrationStore().triggers(null, KIND)) {
      if (sessionId === null || identity(record).target.sessionId === sessionId) invalidate(record, "The session was stopped")
    }
  })
  subscribeSessionArchive((sessionIds) => {
    for (const sessionId of sessionIds) invalidateSession(sessionId, "The session was archived")
  })
}
