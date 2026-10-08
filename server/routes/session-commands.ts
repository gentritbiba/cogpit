import { nativeBinding } from "../agents/nativeBindings"
import { resolveConversationTransition, transitionConversation, type TransitionInput, type TransitionResolution } from "../lib/conversationTransition"
import type { IncomingMessage, ServerResponse } from "node:http"
import { authorizeSession } from "../edition"
import { resolveSessionAgent, runtimeFor } from "../agents/runtimes"
import { attachCommandAuthority, commandDispatcher, commandScope } from "../lib/durableSend"
import { sendJson, withJsonBody, type UseFn } from "../http"
import { sendAgentError } from "./agentErrors"
import { localHost } from "../sessionHosts/localHost"
import { OrchestrationError } from "../orchestration/store"

async function context(req: IncomingMessage, res: ServerResponse, sessionId: unknown, mutate: boolean) {
  if (typeof sessionId !== "string" || !sessionId) throw new OrchestrationError(400, "sessionId is required")
  if (await authorizeSession(req, res, { sessionId }, mutate ? "interact" : "view") === null) return null
  const { kind, filePath, instanceId } = await resolveSessionAgent(sessionId)
  const dispatcher = commandDispatcher()
  const conversation = dispatcher.store.ensureConversation(await nativeBinding(sessionId, kind, filePath))
  if (conversation.binding.sessionId !== sessionId && await authorizeSession(req, res, { sessionId: conversation.binding.sessionId }, mutate ? "interact" : "view") === null) return null
  return { dispatcher, conversation, scope: commandScope(req), runtime: runtimeFor(kind, instanceId) }
}

export function registerSessionCommandRoutes(use: UseFn): void {
  use("/api/conversation-transition", (req, res, next) => {
    if (req.method !== "POST") return next()
    withJsonBody<TransitionInput & TransitionResolution & { action?: string }>(req, res, async (body) => {
      try {
        if (!await context(req, res, body.sessionId, true)) return
        if (body.targetSessionId && await authorizeSession(req, res, { sessionId: body.targetSessionId }, "interact") === null) return
        sendJson(res, 200, body.action === "resolve" ? await resolveConversationTransition(req, body) : await transitionConversation(req, body))
      } catch (error) { sendAgentError(res, error, "Conversation transition failed") }
    })
  })
  use("/api/session-commands", async (req, res, next) => {
    if (req.method === "GET") {
      try {
        const query = new URL(req.url ?? "/", "http://localhost").searchParams
        const ctx = await context(req, res, query.get("sessionId"), false)
        if (!ctx) return
        const { dispatcher, conversation, scope } = ctx
        sendJson(res, 200, { conversation, currentAddress: await localHost.address(conversation.binding.sessionId), pendingTransition: dispatcher.store.pendingTransition(conversation.id, scope), commands: dispatcher.store.commands(conversation.id, scope), replay: dispatcher.store.events(conversation.id, Number(query.get("after") ?? 0), 200, scope) })
      } catch (error) { sendAgentError(res, error, "Failed to read the queue") }
      return
    }
    if (req.method !== "POST") return next()
    withJsonBody<Record<string, unknown>>(req, res, async (body) => {
      try {
        const ctx = await context(req, res, body.sessionId, true)
        if (!ctx) return
        const { dispatcher, conversation, scope, runtime } = ctx
        if (conversation.binding.sessionId !== body.sessionId) throw new OrchestrationError(409, `This conversation moved to ${conversation.binding.sessionId}; open its current session to update the queue`)
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
        sendJson(res, 200, { conversation, commands: dispatcher.store.commands(conversation.id, scope) })
      } catch (error) { sendAgentError(res, error, "Failed to update the queue") }
    })
  })
  use("/api/command-receipt", async (req, res, next) => {
    if (req.method !== "GET") return next()
    try {
      const query = new URL(req.url ?? "/", "http://localhost").searchParams
      const scope = commandScope(req)
      const command = commandDispatcher().store.command(scope, query.get("commandId") ?? "")
      if (!command) return sendJson(res, 404, { error: "Command not found" })
      if (await authorizeSession(req, res, { sessionId: command.receipt.sessionId }, "view") === null) return
      sendJson(res, 200, { receipt: command.receipt })
    } catch (error) { sendAgentError(res, error, "Failed to read receipt") }
  })
}
