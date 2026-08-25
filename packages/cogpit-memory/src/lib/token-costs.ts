// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Token display estimation and cost formatting.
 *
 * Pricing lives in shared/usageCost/pricing.ts, driven by LiteLLM's live rate
 * table — nothing here carries hardcoded rates. What remains is display-only
 * accounting of the thinking/visible output split.
 *
 * Claude Code 2.1.19x+ reports thinking tokens directly on the assistant
 * record, so that half of the split is now exact. Older transcripts recorded
 * only the message_start placeholder usage, so they still fall back to a
 * content estimate at ≈4 chars/token — as does the visible-output half, which
 * the CLI does not break out.
 */

import type { Turn } from "./types"

/** Approximate characters per token for content-based estimation. */
export const CHARS_PER_TOKEN = 4

/** Convert character count to approximate token count. */
function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/** Sum string lengths from an array. */
function totalLength(strings: readonly string[]): number {
  let n = 0
  for (const s of strings) n += s.length
  return n
}

/** Sum JSON-stringified input lengths from tool calls. */
function totalToolInputLength(toolCalls: readonly { input: Record<string, unknown> }[]): number {
  let n = 0
  for (const tc of toolCalls) n += JSON.stringify(tc.input).length
  return n
}

/**
 * Thinking tokens for a turn: the count the model reported when it is
 * available, falling back to a character estimate for older transcripts.
 *
 * A reported 0 is a fact — a turn that did no thinking — so presence is tested
 * rather than truthiness.
 */
export function estimateThinkingTokens(turn: Turn): number {
  const reported = turn.tokenUsage?.output_tokens_details?.thinking_tokens
  if (typeof reported === "number") return reported
  return charsToTokens(totalLength(turn.thinking.map((b) => b.thinking)))
}

/** Estimate non-thinking output tokens (text + tool use JSON). */
export function estimateVisibleOutputTokens(turn: Turn): number {
  return charsToTokens(totalLength(turn.assistantText) + totalToolInputLength(turn.toolCalls))
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "—"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
