/**
 * Long-running goals, in the two shapes the agents keep them: Claude Code
 * records goal state in its transcript and takes a `/goal` slash command;
 * Codex exposes goals through its app-server thread API, which Cogpit proxies.
 */
import { asRecord } from "../../../shared/objects"

export type TranscriptGoalStatus = "active" | "achieved" | "failed"

export interface TranscriptGoalState {
  condition: string
  status: TranscriptGoalStatus
  reason?: string
  iterations: number
  durationMs: number
  tokens: number
}

/**
 * Read the goal a transcript-tracked agent records: Claude Code writes its
 * native `goal_status` attachment into the session JSONL.
 */
export function extractTranscriptGoalState(
  messages: Array<{ type: string; [key: string]: unknown }>,
): TranscriptGoalState | null {
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

/** The proxied thread-goal endpoint for an agent whose goals live on the CLI. */
export function threadGoalPath(threadId: string): string {
  return `/api/codex/goals/${encodeURIComponent(threadId)}`
}
