// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Token display estimation and cost formatting.
 *
 * Pricing lives in shared/usageCost/pricing.ts, driven by LiteLLM's live rate
 * table — nothing here carries hardcoded rates. What remains is content-based
 * estimation for display only: Claude Code's JSONL records the message_start
 * placeholder usage, so thinking tokens are absent and output is undercounted;
 * the chart's thinking/visible split is reconstructed from content at
 * ≈4 chars/token.
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

/** Estimate thinking tokens from a turn's thinking blocks. */
export function estimateThinkingTokens(turn: Turn): number {
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
