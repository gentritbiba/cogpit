import type { AgentKind } from "../../shared/session/agent-descriptors"
import { classifyAgentFailure, type AgentFailureReason } from "../../shared/session/agentFailures"
import { recordTelemetry } from "../telemetry"

export interface FailedAgentWork {
  sessionId?: string | null
  kind: AgentKind
  message: string
  httpStatus?: number
  /** Why, when the agent's error says so in more than its message. */
  reason?: AgentFailureReason
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
  const reason = work.reason ?? failure.reason
  console.warn(`[agent] ${phase} failed session=${work.sessionId || "-"} agent=${work.kind} reason=${reason}${status}: ${firstLine}`)
  recordTelemetry("agent.error", {
    agent: work.kind,
    phase,
    reason,
    ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
  })
}
