import { resolveSessionAgent, runtimeFor } from "../agents/runtimes"
import type { AgentRuntime, SendOutcome, SendRequest } from "../agents/runtimes"
import { ErrorCodes, RouteError } from "./routeError"
import { setSessionsArchived } from "./sessionArchive"

/**
 * Deliver a message to an existing session, for the send route and the session hosts.
 * Throws a 409 `RouteError` when the agent refuses it as busy.
 */
export async function sendToSession(
  sessionId: string,
  request: SendRequest,
): Promise<{ runtime: AgentRuntime; outcome: SendOutcome }> {
  const { kind, filePath, instanceId } = await resolveSessionAgent(sessionId)
  const runtime = runtimeFor(kind, instanceId)
  const outcome = await runtime.send(sessionId, { ...request, filePath })
  if (outcome.delivery === "busy") {
    throw new RouteError(409, ErrorCodes.CONFLICT, "Session is already active")
  }
  // A message to an archived session resumes it, and a resumed session
  // belongs back in the sidebar right away.
  setSessionsArchived([sessionId], false).catch(() => {})
  return { runtime, outcome }
}
