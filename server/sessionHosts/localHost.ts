import { respondToPendingInput } from "../agents/pendingInput"
import { resolveSessionAgent, runtimeFor, runtimeForSession } from "../agents/runtimes"
import { readSessionResult } from "../lib/sessionResult"
import { clearTurnError, readSessionState, recordTurnError, waitForSessions } from "../lib/sessionWait"
import { listProjects } from "../routes/projects/projectList"
import { createSession } from "../lib/sessionCreate"
import { sendToSession } from "../lib/sessionSend"
import { storeForPath } from "../agents"
import { findJsonlPath } from "../sessionPaths"
import { startFields, type SessionHost } from "./types"

export const localHost: SessionHost = {
  id: "local",
  name: "this machine",
  remote: false,

  async create(input) {
    const started = await createSession({
      ...startFields(input),
      retry: { requestId: input.requestId, scope: input.scope },
    })
    return { sessionId: started.sessionId, dirName: started.dirName }
  },

  async send(sessionId, message, { interrupt = false } = {}) {
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

  state: readSessionState,
  wait: waitForSessions,
  result: readSessionResult,
  respond: respondToPendingInput,

  async interrupt(sessionId) {
    const { kind } = await resolveSessionAgent(sessionId)
    return runtimeFor(kind).interrupt(sessionId)
  },

  async stop(sessionId) {
    const { kind } = await resolveSessionAgent(sessionId)
    return runtimeFor(kind).stop(sessionId)
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
