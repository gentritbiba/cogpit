import { nativeBinding } from "../agents/nativeBindings"
import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import type { CommandIntent, CommandReceipt, NativeBinding } from "../../shared/contracts/orchestration"
import { accessAtLeast } from "../../shared/contracts/sessionAccess"
import { resolveSessionAgent, runtimeFor } from "../agents/runtimes"
import type { AcceptedAnswer, AgentRuntime, SendRequest } from "../agents/runtimeTypes"
import { accessLevelOf, editionModule, getRequestPrincipal, sendTurn, type SendContext } from "../edition"
import { getRequestAuthentication, setRequestAuthentication, type RequestAuthentication } from "../requestAuthentication"
import { setRequestPrincipal } from "../requestPrincipal"
import { isSessionTokenActive } from "../security"
import { SESSION_ABSOLUTE_TTL_MS, SESSION_IDLE_TTL_MS } from "../sessionConstants"
import { CommandDispatcher } from "../orchestration/dispatcher"
import { beforeOrchestrationClose, orchestrationStore } from "../orchestration/storage"
import { checkTriggerDelivery, DeliveryRefused } from "../orchestration/deliveryGuards"
import type { DispatchRefusal } from "../orchestration/dispatcher"
import { OrchestrationError, type ClaimedOccurrence, type DispatcherLease, type StoredCommand } from "../orchestration/store"
import { isTerminalOccurrence, type GrantRef } from "../../shared/contracts/triggers"
import { setSessionsArchived } from "./sessionArchive"
import { liveAuthority, resolveExecution } from "./triggers/authority"

let active: { store: ReturnType<typeof orchestrationStore>; dispatcher: CommandDispatcher } | undefined
export function commandDispatcher(): CommandDispatcher {
  const store = orchestrationStore()
  if (!active || active.store !== store) {
    active?.dispatcher.close()
    const dispatcher = new CommandDispatcher(store)
    dispatcher.start()
    active = { store, dispatcher }
    beforeOrchestrationClose(closeCommandDispatcher)
  }
  return active.dispatcher
}
export function closeCommandDispatcher(): void { active?.dispatcher.close(); active = undefined }
export function commandScope(req?: IncomingMessage): string {
  const principal = req && getRequestPrincipal(req)
  if (editionModule().auth && !principal) throw new OrchestrationError(403, "A signed-in account is required for durable delivery")
  return principal?.userId ?? "local"
}

function executionRequest(authentication: RequestAuthentication | null, originalScope: string): IncomingMessage | null {
  const request = new IncomingMessage(new Socket())
  request.method = "POST"
  request.url = "/api/send-message"
  const auth = editionModule().auth
  if (!auth) {
    if (authentication?.kind === "session" && !isSessionTokenActive(authentication.token)) return null
    return originalScope === "local" ? request : null
  }
  if (authentication?.kind !== "session" || !isSessionTokenActive(authentication.token)) return null
  const restored = auth.sessions.restore(authentication.token)
  const now = Date.now()
  if (!restored?.principal || restored.principal.userId !== originalScope || now - restored.createdAt > SESSION_ABSOLUTE_TTL_MS || now - restored.lastActivity > SESSION_IDLE_TTL_MS) return null
  setRequestAuthentication(request, { kind: "session", token: authentication.token, principal: restored.principal })
  setRequestPrincipal(request, restored.principal)
  return request
}

export function refreshExecutionRequest(req: IncomingMessage): IncomingMessage | null { return executionRequest(getRequestAuthentication(req), commandScope(req)) }
/** A request acting as `authentication` again for `scope`, while that sign-in is still active. */
export function executionRequestFor(authentication: RequestAuthentication | null, scope: string): IncomingMessage | null { return executionRequest(authentication, scope) }

/** The session a command goes to, and the crew lead it speaks for when it carries one. */
async function mayDeliver(request: IncomingMessage, command: StoredCommand): Promise<boolean> {
  const lead = command.payload.leadSessionId
  for (const sessionId of typeof lead === "string" ? [command.receipt.sessionId, lead] : [command.receipt.sessionId]) {
    const level = await accessLevelOf(request, sessionId)
    if (level === null || !accessAtLeast(level, "interact")) return false
  }
  return true
}

/** The code a refusal carries when the fix is a fresh authorization rather than a review. */
export const REAUTHORIZE = "REAUTHORIZE"

/**
 * The request a command is delivered as: the live sign-in it was admitted
 * under, or for a trigger's command the authority its occurrence holds now —
 * the sign-in someone reauthorized it with, else its grant, re-checked. The
 * occurrence's grant can be renewed while the command and its fingerprint
 * stay the same.
 */
async function deliveryRequest(command: StoredCommand, runtime: AgentRuntime, authentication: RequestAuthentication | null, scope: string): Promise<IncomingMessage | DispatchRefusal> {
  const trigger = command.payload.trigger as { occurrenceId?: unknown } | undefined
  if (typeof trigger?.occurrenceId !== "string") return executionRequest(authentication, scope) ?? { disposition: "held", reason: "Sign in with access to this session, then resume its queue." }
  const refusal = (reason: string): DispatchRefusal => ({ disposition: "held", reason, code: REAUTHORIZE })
  // A run cancelled, settled or deleted takes its message with it, whatever revived the message.
  const occurrence = commandDispatcher().store.occurrence(command.scope, trigger.occurrenceId)
  if (!occurrence || isTerminalOccurrence(occurrence.state)) return { disposition: "cancelled", reason: "The run this message belongs to is no longer active" }
  const live = liveAuthority(command.scope, trigger.occurrenceId)
  if (live !== undefined) return executionRequest(live, scope) ?? refusal("The sign-in that reauthorized this run expired; reauthorize it again")
  const grant = occurrence.grant
  if (!grant || !command.payload.executionGrant) return refusal("This run needs to be reauthorized by its owner")
  const resolved = await resolveExecution(grant, "session.send", { agent: runtime.kind, instanceId: runtime.instanceId ?? "default", sessionId: command.receipt.sessionId, bindingRevision: command.receipt.bindingRevision }, scope)
  return "req" in resolved ? resolved.req : refusal(resolved.hold)
}

/** A trigger command's consumer guard, read against the occurrence as it stands now. */
async function triggerRefusal(command: StoredCommand): Promise<DispatchRefusal | null> {
  const trigger = command.payload.trigger as { occurrenceId?: unknown } | undefined
  if (typeof trigger?.occurrenceId !== "string") return null
  const verdict = await checkTriggerDelivery(commandDispatcher().store.occurrence(command.scope, trigger.occurrenceId), command)
  return verdict.allow ? null : { disposition: verdict.disposition, reason: verdict.reason }
}

/**
 * Lets the dispatcher deliver a conversation's commands. `req` is the live
 * sign-in its own commands deliver as; a command admitted under a grant
 * delivers as that grant whichever authority is attached. `ifMissing` keeps
 * an authority someone attached live.
 */
export function attachCommandAuthority(scope: string, conversationId: string, runtime: AgentRuntime, req?: IncomingMessage, ifMissing = false): void {
  const authentication = req ? getRequestAuthentication(req) : null
  const dispatcher = commandDispatcher()
  if (ifMissing && dispatcher.hasAuthority(scope, conversationId)) return
  dispatcher.attach(scope, conversationId, {
    async authorize(command) {
      const request = await deliveryRequest(command, runtime, authentication, scope)
      if (!(request instanceof IncomingMessage)) return request
      if (!await mayDeliver(request, command)) return false
      return await triggerRefusal(command) ?? true
    },
    async deliver(command, currentAttempt) {
      if (command.receipt.intent === "steer" && !runtime.descriptor.capabilities.midTurnSteering && !(command.payload.notification && runtime.descriptor.capabilities.activeNotifications)) throw new OrchestrationError(400, "This provider does not support steering a running turn")
      const request = await deliveryRequest(command, runtime, authentication, scope)
      if (!(request instanceof IncomingMessage)) throw new DeliveryRefused(request.disposition, request.reason, request.code)
      if (!await mayDeliver(request, command)) throw new OrchestrationError(403, "Session access changed")
      const refusal = await triggerRefusal(command)
      if (refusal) throw new DeliveryRefused(refusal.disposition, refusal.reason)
      // Read again at the handoff, after the guard's and the edition's awaits: nothing has reached the agent yet.
      const authorizeHandoff = async () => {
        const late = await triggerRefusal(command)
        if (late) throw new DeliveryRefused(late.disposition, late.reason)
        const current = await deliveryRequest(command, runtime, authentication, scope)
        if (!(current instanceof IncomingMessage)) throw new DeliveryRefused(current.disposition, current.reason, current.code)
        if (!await mayDeliver(current, command)) throw new DeliveryRefused("held", "Session access changed before delivery")
      }
      const assertCurrent = () => { if (!currentAttempt()) throw new OrchestrationError(409, "Dispatcher ownership changed before provider delivery") }
      assertCurrent()
      if (command.receipt.intent === "restart") await runtime.interrupt(command.receipt.sessionId)
      const context: SendContext = {
        receivedAt: command.receipt.createdAt,
        route: typeof command.payload.questionId === "string" ? "answer" : "send-message",
        session: { sessionId: command.receipt.sessionId, agent: runtime.kind },
        ...(typeof command.payload.questionId === "string" ? { toolUseId: command.payload.questionId } : {}),
      }
      const fencedRuntime = { ...runtime, send: async (id: string, input: SendRequest) => {
        await authorizeHandoff()
        assertCurrent()
        return runtime.send(id, input)
      } }
      const { executionGrant: _grant, trigger: _trigger, ...payload } = command.payload
      const outcome = await sendTurn(request, fencedRuntime, command.receipt.sessionId, { ...payload, deliveryIntent: command.receipt.intent, commandId: command.receipt.nativeMessageId } as SendRequest, context)
      if (outcome.delivery !== "busy" && outcome.turnId && !outcome.completion && runtime.waitForCompletion) outcome.completion = runtime.waitForCompletion(command.receipt.sessionId, outcome.turnId)
      if (outcome.delivery !== "busy") void setSessionsArchived([command.receipt.sessionId], false).catch(() => {})
      return outcome
    },
    activity: (command) => runtime.activity(command.receipt.sessionId),
  })
}

interface CommandTarget {
  sessionId: string
  request: SendRequest
  req?: IncomingMessage
  binding?: NativeBinding
  runtime?: AgentRuntime
}

async function commandConversation(options: CommandTarget, extra: Record<string, unknown>, executionGrant?: GrantRef) {
  const { sessionId, request, req } = options
  const resolved = options.runtime ? { kind: options.runtime.kind, instanceId: options.runtime.instanceId, filePath: request.filePath } : await resolveSessionAgent(sessionId)
  const runtime = options.runtime ?? runtimeFor(resolved.kind, resolved.instanceId)
  const dispatcher = commandDispatcher()
  const scope = commandScope(req)
  if (req) {
    const level = await accessLevelOf(req, sessionId)
    if (level === null || !accessAtLeast(level, "interact")) throw new OrchestrationError(403, "Session access is required before queueing a message")
  }
  const binding = options.binding ?? await nativeBinding(sessionId, resolved.kind, resolved.filePath, request.cwd)
  const conversation = dispatcher.store.ensureConversation(binding)
  if (conversation.binding.sessionId !== sessionId) throw new OrchestrationError(409, "This conversation moved to another native session; open its current binding")
  if (executionGrant) attachCommandAuthority(scope, conversation.id, runtime, undefined, true)
  else attachCommandAuthority(scope, conversation.id, runtime, req)
  const payload: Record<string, unknown> = { ...request, filePath: resolved.filePath ?? binding.filePath, ...extra, ...(executionGrant ? { executionGrant } : {}) }
  return { dispatcher, store: dispatcher.store, scope, conversation, payload }
}

/**
 * Admits a claimed trigger occurrence's message as one durable command, in
 * the transaction that records it admitted. `req` is the grant's execution
 * request; delivery re-checks the grant itself. Null when the occurrence was
 * settled instead (fenced by user activity, moved binding, lost lease).
 */
export async function admitOccurrenceCommand(options: CommandTarget & {
  req: IncomingMessage
  claim: ClaimedOccurrence
  lease: DispatcherLease
  intent: CommandIntent
  executionGrant?: GrantRef
  expectedBindingRevision?: number
}): Promise<CommandReceipt | null> {
  const { dispatcher, store, scope, conversation, payload } = await commandConversation(options, {}, options.executionGrant)
  if (scope !== options.claim.occurrence.scope) throw new OrchestrationError(403, "A task runs only as the account that owns it")
  const receipt = store.admitForOccurrence(options.claim, options.lease, conversation.id, payload, options.intent, options.expectedBindingRevision)
  if (receipt) void dispatcher.tick()
  return receipt
}

/** Attaches delivery authority for trigger commands waiting without one: after a restart, or once reauthorized. */
export async function attachGrantAuthorities(): Promise<void> {
  const dispatcher = commandDispatcher()
  for (const command of dispatcher.store.queued()) {
    if (!command.payload.trigger || dispatcher.hasAuthority(command.scope, command.receipt.conversationId)) continue
    try {
      const resolved = await resolveSessionAgent(command.receipt.sessionId)
      attachCommandAuthority(command.scope, command.receipt.conversationId, runtimeFor(resolved.kind, resolved.instanceId), undefined, true)
    } catch { /* The session is gone; its command stays queued for review. */ }
  }
}

export async function admitSessionCommand(options: CommandTarget & {
  commandId: string
  intent?: CommandIntent
  /** The intent when the caller names none; a retry keeps the one its command was first admitted with. */
  defaultIntent?: CommandIntent
  /** A crew lead the command speaks for: delivery keeps requiring access to it too. */
  leadSessionId?: string
  answer?: AcceptedAnswer
  answerInput?: unknown
}): Promise<CommandReceipt> {
  const { commandId, answer } = options
  const { dispatcher, store, scope, conversation, payload } = await commandConversation(options, options.leadSessionId ? { leadSessionId: options.leadSessionId } : {})
  let receipt: CommandReceipt
  if (answer?.durableQuestion) {
    const { instanceId, sessionId: questionSessionId, requestId } = answer.durableQuestion
    payload.questionId = requestId
    payload.answerInput = options.answerInput
    payload.answerQuestion = answer.durableQuestion
    receipt = store.admitAnswer(scope, commandId, conversation.id, payload, instanceId, questionSessionId, requestId)
  } else receipt = store.admit(scope, commandId, conversation.id, payload, options.intent ?? store.command(scope, commandId)?.receipt.intent ?? options.defaultIntent)
  void dispatcher.tick()
  return receipt
}
