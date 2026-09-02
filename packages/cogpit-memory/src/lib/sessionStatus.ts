// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Session status: what the agent is doing right now, and how to label it.
 *
 * Status is always derived from raw transcript records, never stored as app
 * state. Each format derives its own — this file only routes to the format the
 * records were written in, and holds the presentation labels.
 */

import { formatForRecords } from "./agents"
import type { RawRecord, SessionStatus, SessionStatusInfo } from "./types"

export type { SessionStatus, SessionStatusInfo } from "./types"

/**
 * Derive session status from raw JSONL record objects.
 *
 * The format is resolved from the records themselves, in `AGENT_KINDS` order,
 * so a transcript that carries no positive discriminator lands on the terminal
 * format — the same fallback the parser uses.
 */
export function deriveSessionStatus(rawMessages: RawRecord[]): SessionStatusInfo {
  return formatForRecords(rawMessages).status(rawMessages)
}

/** Tools that indicate the agent is waiting for sub-agents to finish. */
const AGENT_TOOLS = new Set(["Agent", "TaskOutput", "spawn_agent", "wait_agent"])

/** Human-readable label for terminal_reason values from Claude Code. */
export function getTerminalReasonLabel(reason: string): string {
  switch (reason) {
    case "max_turns": return "Stopped — turn limit reached"
    case "aborted_tools": return "Stopped — tools aborted"
    case "blocking_limit": return "Stopped — blocked"
    default: return `Stopped — ${reason.replace(/_/g, " ")}`
  }
}

/** Human-readable label for a session status. Returns null for "idle". */
export function getStatusLabel(
  status: SessionStatus | undefined,
  toolName?: string,
  terminalReason?: string,
  pendingAgents?: number,
): string | null {
  switch (status) {
    case "thinking": return "Thinking..."
    case "tool_use":
      if (toolName && AGENT_TOOLS.has(toolName)) return "Running agents..."
      return toolName ? `Using ${toolName}` : "Using tool..."
    case "processing": return "Processing..."
    case "compacting": return "Compressing context..."
    case "deferred": return "Awaiting permission review"
    case "awaiting_agents":
      if (pendingAgents && pendingAgents > 0) {
        return `Waiting on ${pendingAgents} agent${pendingAgents === 1 ? "" : "s"}...`
      }
      return "Waiting on agents..."
    case "completed":
      if (terminalReason) return getTerminalReasonLabel(terminalReason)
      return "Done"
    default: return null
  }
}
