export type ClaudeGoalStatus = "active" | "achieved" | "failed"

export interface ClaudeGoalState {
  condition: string
  status: ClaudeGoalStatus
  reason?: string
  iterations: number
  durationMs: number
  tokens: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Read Claude Code's native `goal_status` attachment from session JSONL. */
export function extractClaudeGoalState(
  messages: Array<{ type: string; [key: string]: unknown }>,
): ClaudeGoalState | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.type !== "attachment") continue
    const attachment = asRecord(message.attachment)
    if (attachment?.type !== "goal_status") continue

    const condition = typeof attachment.condition === "string" ? attachment.condition : ""
    const met = attachment.met === true
    const failed = attachment.failed === true
    const sentinel = attachment.sentinel === true
    // Claude writes a met sentinel when /goal is explicitly cleared. It is a
    // boundary marker, not an achieved goal.
    if (sentinel && met) return null
    if (!condition) return null

    return {
      condition,
      status: failed ? "failed" : met ? "achieved" : "active",
      reason: typeof attachment.reason === "string" ? attachment.reason : undefined,
      iterations: typeof attachment.iterations === "number" ? attachment.iterations : 0,
      durationMs: typeof attachment.durationMs === "number" ? attachment.durationMs : 0,
      tokens: typeof attachment.tokens === "number" ? attachment.tokens : 0,
    }
  }
  return null
}
