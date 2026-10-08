import { accessLevelOf, startTurn } from "../edition"
import { accessAtLeast } from "../../shared/contracts/sessionAccess"
import { OrchestrationError } from "../orchestration/store"
import { resolveConversationTransition, transitionConversation } from "../lib/conversationTransition"
import { respondToPendingInput } from "../agents/pendingInput"
import { resolveSessionAgent, runtimeFor, runtimeForSession } from "../agents/runtimes"
import { readSessionResult } from "../lib/sessionResult"
import { clearTurnError, readSessionState, recordTurnError, waitForSessions } from "../lib/sessionWait"
import { listProjects } from "../routes/projects/projectList"
import { createSession } from "../lib/sessionCreate"
import { sendToSession } from "../lib/sessionSend"
import { admitSessionCommand, commandDispatcher, commandScope } from "../lib/durableSend"
import { storeForPath } from "../agents"
import { findJsonlPath } from "../sessionPaths"
import { startFields, type SessionHost } from "./types"

export const localHost: SessionHost = {
  id: "local",
  name: "this machine",
  remote: false,
  transition: (input, req) => "action" in input ? resolveConversationTransition(req, input) : transitionConversation(req, input),

  async create(input) {
    const inputFields = {
      ...startFields(input),
      retry: { requestId: input.requestId, scope: input.scope },
    }
    const started = input.req ? await createSession(inputFields, (runtime, request) => startTurn(input.req!, Date.now(), runtime, request)) : await createSession(inputFields)
    return { sessionId: started.sessionId, dirName: started.dirName }
  },

  async send(sessionId, message, { interrupt = false, commandId, req, intent } = {}) {
    if (commandId) {
      const receipt = await admitSessionCommand({ sessionId, commandId, request: { message }, req, intent: intent ?? (interrupt ? "restart" : "queue") })
      return { delivery: receipt.state, receipt }
    }
    if (interrupt) await this.interrupt(sessionId)
    clearTurnError(sessionId)
    const { outcome } = await sendToSession(sessionId, { message })
    // A resume reports its failure only on this promise; keep it for `wait`.
    outcome.completion
      ?.then((result) => {
        if (result.isError) recordTurnError(sessionId, result.message || "The turn failed")
      })
      .catch((error: unknown) => recordTurnError(sessionId, error instanceof Error ? error.message : String(error)))
    return { delivery: outcome.delivery }
  },

  async receipt(commandId, req, waitMs) {
    const dispatcher = commandDispatcher()
    const scope = commandScope(req)
    const authorize = async () => {
      const receipt = dispatcher.store.command(scope, commandId)?.receipt
      if (receipt && req) { const level = await accessLevelOf(req, receipt.sessionId); if (!level || !accessAtLeast(level, "view")) throw new OrchestrationError(403, "Session access is required to read this receipt") }
      return receipt ?? null
    }
    const receipt = await authorize()
    if (!receipt || waitMs === undefined) return receipt
    await dispatcher.wait(scope, commandId, waitMs)
    return authorize()
  },

  state: readSessionState,
  wait: waitForSessions,
  result: readSessionResult,
  respond: respondToPendingInput,

  async interrupt(sessionId) {
    const { kind, instanceId } = await resolveSessionAgent(sessionId)
    return runtimeFor(kind, instanceId).interrupt(sessionId)
  },

  async stop(sessionId) {
    const { kind, instanceId } = await resolveSessionAgent(sessionId)
    return runtimeFor(kind, instanceId).stop(sessionId)
  },

  async has(sessionId) {
    return runtimeForSession(sessionId) !== null || (await findJsonlPath(sessionId)) !== null
  },

  async address(sessionId) {
    const filePath = await findJsonlPath(sessionId)
    return (filePath && await storeForPath(filePath)?.sessionAddress(filePath)) || null
  },

  projects: listProjects,
}
