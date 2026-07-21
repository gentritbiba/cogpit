// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Interactive prompt detection — plan approval and user question states.
 */

import type { ParsedSession, Turn } from "./types"

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlanApprovalState {
  type: "plan"
  allowedPrompts?: Array<{ tool: string; prompt: string }>
}

export interface UserQuestionState {
  type: "question"
  toolUseId: string
  questions: Array<{
    question: string
    header?: string
    options: Array<{ label: string; description?: string }>
    multiSelect?: boolean
  }>
}

export type PendingInteraction = PlanApprovalState | UserQuestionState | null

// ── Detection ────────────────────────────────────────────────────────────────

/**
 * Check if the previous turn's last tool call is the same interactive tool
 * with a pending/error result -- indicates a stuck loop we should suppress.
 */
export function isStuckInteractiveLoop(turns: Turn[], toolName: string): boolean {
  if (turns.length < 2) return false
  const prevTurn = turns[turns.length - 2]
  const prevLastTC = prevTurn.toolCalls[prevTurn.toolCalls.length - 1]
  return prevLastTC?.name === toolName && (prevLastTC.result === null || prevLastTC.isError)
}

/**
 * Check whether the turn contains assistant content (text/thinking/tool calls)
 * chronologically after the block holding the given tool call — meaning the
 * agent already moved past it and the prompt is no longer answerable.
 */
function agentContinuedAfterToolCall(turn: Turn, toolCallId: string): boolean {
  const blocks = turn.contentBlocks
  const blockIndex = blocks.findIndex(
    (block) => block.kind === "tool_calls" && block.toolCalls.some((tc) => tc.id === toolCallId),
  )
  if (blockIndex === -1) return false
  return blocks.slice(blockIndex + 1).some(
    (block) => block.kind === "text" || block.kind === "thinking" || block.kind === "tool_calls",
  )
}

/**
 * Detect if the session is waiting for user interaction (plan approval or
 * AskUserQuestion). Returns the interaction state or null.
 */
export function detectPendingInteraction(session: ParsedSession): PendingInteraction {
  const { turns } = session
  if (turns.length === 0) return null

  const lastTurn = turns[turns.length - 1]
  if (!lastTurn || lastTurn.toolCalls.length === 0) return null

  const lastToolCall = lastTurn.toolCalls[lastTurn.toolCalls.length - 1]
  if (!lastToolCall) return null

  const { name } = lastToolCall
  if (name !== "ExitPlanMode" && name !== "AskUserQuestion") return null

  // A successful (non-error) result means the user already responded
  if (lastToolCall.result !== null && !lastToolCall.isError) return null

  // Suppress if the agent is stuck re-calling the same interactive tool
  if (isStuckInteractiveLoop(turns, name)) return null

  // If the tool call errored and the agent kept going (more assistant content
  // after it in the same turn), the prompt is dead — e.g. AskUserQuestion
  // failed instantly and the agent fell back to plain text. A genuinely
  // pending prompt blocks the turn, so nothing can follow it.
  if (lastToolCall.isError && agentContinuedAfterToolCall(lastTurn, lastToolCall.id)) return null

  const input = lastToolCall.input as Record<string, unknown>

  if (name === "ExitPlanMode") {
    return {
      type: "plan",
      allowedPrompts: input.allowedPrompts as PlanApprovalState["allowedPrompts"],
    }
  }

  // AskUserQuestion
  const questions = input.questions as UserQuestionState["questions"] | undefined
  if (questions && questions.length > 0) {
    return { type: "question", toolUseId: lastToolCall.id, questions }
  }

  return null
}
