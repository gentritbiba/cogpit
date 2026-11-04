import type { AgentKind } from "../../shared/session/agent-descriptors"
import { classifyAgentFailure } from "../../shared/session/agentFailures"

export interface FailedAgentWork {
  sessionId?: string | null
  kind: AgentKind
  message: string
  httpStatus?: number
}

/**
 * One line per failed start or turn, so a report that "nothing happened" has a
 * trail on the server: which session, which agent, and which of the cases the
 * UI tells apart.
 */
export function logAgentFailure(phase: "start" | "turn", work: FailedAgentWork): void {
  const failure = classifyAgentFailure(work.message, work.httpStatus)
  const status = failure.httpStatus === undefined ? "" : ` status=${failure.httpStatus}`
  const firstLine = work.message.split(/\r?\n/, 1)[0].slice(0, 300)
  console.warn(`[agent] ${phase} failed session=${work.sessionId || "-"} agent=${work.kind} reason=${failure.reason}${status}: ${firstLine}`)
}
