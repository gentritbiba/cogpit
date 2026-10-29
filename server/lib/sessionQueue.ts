import { publishSessionCancellation } from "./sessionCancellation"
import type { IncomingMessage } from "node:http"
import { nativeBinding } from "../agents/nativeBindings"
import { resolveSessionAgent, runtimeFor } from "../agents/runtimes"
import type { AgentRuntime } from "../agents/runtimeTypes"
import type { CommandReceipt, Conversation } from "../../shared/contracts/orchestration"
import type { CommandDispatcher } from "../orchestration/dispatcher"
import { OrchestrationError } from "../orchestration/store"
import { attachCommandAuthority, commandDispatcher, commandScope } from "./durableSend"

/**
 * A session's durable message queue, as the queue panel and `cogpit-session
 * queue` act on it. Callers authorize the session first.
 */

export interface QueueContext {
  dispatcher: CommandDispatcher
  conversation: Conversation
  scope: string
  runtime: AgentRuntime
}

export async function queueContext(sessionId: string, req?: IncomingMessage): Promise<QueueContext> {
  const { kind, filePath, instanceId } = await resolveSessionAgent(sessionId)
  const dispatcher = commandDispatcher()
  const conversation = dispatcher.store.ensureConversation(await nativeBinding(sessionId, kind, filePath))
  return { dispatcher, conversation, scope: commandScope(req), runtime: runtimeFor(kind, instanceId) }
}

export function applyQueueAction(ctx: QueueContext, sessionId: string, body: Record<string, unknown>, req?: IncomingMessage): CommandReceipt[] {
  const { dispatcher, conversation, scope, runtime } = ctx
  if (conversation.binding.sessionId !== sessionId) throw new OrchestrationError(409, `This conversation moved to ${conversation.binding.sessionId}; open its current session to update the queue`)
  const { action, commandId } = body
  const id = typeof commandId === "string" ? commandId : ""
  attachCommandAuthority(scope, conversation.id, runtime, req)
  const command = id ? dispatcher.store.command(scope, id) : null
  if (id && command?.receipt.conversationId !== conversation.id) throw new OrchestrationError(404, "Command not found in this conversation")
  switch (action) {
    case "resume": dispatcher.store.resume(scope, conversation.id); break
    case "cancel": dispatcher.store.cancel(scope, id); break
    case "edit": {
      if (!command || typeof body.message !== "string" || !body.message.trim() || typeof body.newCommandId !== "string") throw new OrchestrationError(400, "message and a newCommandId are required")
      dispatcher.store.replace(scope, id, body.newCommandId, { ...command.payload, message: body.message }); break
    }
    case "reorder": {
      if (!Array.isArray(body.commandIds) || !body.commandIds.every((value) => typeof value === "string")) throw new OrchestrationError(400, "commandIds must list the queued commands")
      dispatcher.store.reorder(scope, conversation.id, body.commandIds); break
    }
    case "resolve": {
      if (body.disposition !== "completed" && body.disposition !== "failed") throw new OrchestrationError(400, "Choose completed or failed after inspecting native history")
      dispatcher.store.resolveUnknown(scope, id, body.disposition); break
    }
    case "resend": {
      if (!command || typeof body.newCommandId !== "string" || body.confirmDuplicateRisk !== true) throw new OrchestrationError(409, "Explicitly confirm a possible duplicate and supply a newCommandId")
      dispatcher.store.resendUnknown(scope, id, body.newCommandId); break
    }
    case "steer":
    case "restart": {
      if (!command || typeof body.newCommandId !== "string") throw new OrchestrationError(400, "A newCommandId is required")
      if (action === "steer" && !runtime.descriptor.capabilities.midTurnSteering) throw new OrchestrationError(400, "This provider does not support steering")
      dispatcher.store.promote(scope, id, body.newCommandId, action); break
    }
    default: throw new OrchestrationError(400, "Unknown queue action")
  }
  void dispatcher.tick()
  return dispatcher.store.commands(conversation.id, scope)
}

/**
 * Cancels the messages still waiting for a session, and the results its own
 * children would still report to it, so stopping it is final: neither can
 * start it again.
 */
export async function cancelWaitingMessages(sessionId: string): Promise<void> {
  publishSessionCancellation(sessionId)
  const { kind, filePath } = await resolveSessionAgent(sessionId)
  const store = commandDispatcher().store
  store.muteTasksOf(sessionId)
  const conversation = store.findConversation(await nativeBinding(sessionId, kind, filePath))
  if (conversation) store.cancelWaiting(conversation.id)
}
