/**
 * Token cost calculation library — single source of truth.
 *
 * Pricing is reverse-engineered from the Claude Code binary (v2.1.53) to match
 * exactly what CC reports.  CC calculates cost per API call in the message_delta
 * handler using final usage from the streaming response — but the JSONL only
 * records the message_start placeholder usage (output_tokens is severely
 * undercounted, thinking tokens are omitted entirely).  We compensate by
 * estimating output from actual content (≈4 chars/token).
 */

import type { Turn, SubAgentMessage } from "./types"
import { resolveTier } from "./pricingTiers"

// ── Re-exports (preserve public API) ─────────────────────────────────────────

export type { PricingTier } from "./pricingTiers"
export { EXTENDED_CONTEXT_THRESHOLD, MODEL_TIERS, FAMILY_FALLBACKS, resolveTier } from "./pricingTiers"
export type { UsageBucket, AgentBreakdown, ModelBreakdown, CacheBreakdown } from "./costAnalytics"
export { computeAgentBreakdown, computeModelBreakdown, computeCacheBreakdown } from "./costAnalytics"

// ── Constants ─────────────────────────────────────────────────────────────────

/** Approximate characters per token for content-based estimation. */
export const CHARS_PER_TOKEN = 4

// ── Cost Calculation ─────────────────────────────────────────────────────────

export interface CostInput {
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  webSearchRequests?: number
}

/**
 * Calculate the cost of a single API call / turn.
 *
 * This is the single entry point for all cost calculations.  All other
 * functions in the codebase should use this instead of computing cost
 * themselves.
 */
export function calculateCost(c: CostInput): number {
  const totalInput = c.inputTokens + c.cacheWriteTokens + c.cacheReadTokens
  const p = resolveTier(c.model ?? "", totalInput)
  return (
    (c.inputTokens / 1_000_000) * p.input +
    (c.outputTokens / 1_000_000) * p.output +
    (c.cacheWriteTokens / 1_000_000) * p.cacheWrite +
    (c.cacheReadTokens / 1_000_000) * p.cacheRead +
    (c.webSearchRequests ?? 0) * p.webSearch
  )
}

/**
 * Backward-compatible wrapper.  Prefer `calculateCost()` for new code.
 */
export function calculateTurnCost(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  return calculateCost({ model, inputTokens, outputTokens, cacheWriteTokens: cacheCreationTokens, cacheReadTokens })
}

// ── Output Token Estimation ──────────────────────────────────────────────────
//
// Claude Code's JSONL records `output_tokens` from the streaming message_start
// event — a placeholder that does NOT include the final count.  Thinking tokens
// are never included.  We estimate real output from actual content.

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

/** Estimate total output tokens (thinking + visible). Uses max(estimated, reported). */
export function estimateTotalOutputTokens(turn: Turn): number {
  const estimated = estimateThinkingTokens(turn) + estimateVisibleOutputTokens(turn)
  return Math.max(estimated, turn.tokenUsage?.output_tokens ?? 0)
}

/** Estimate output tokens for a sub-agent message. */
export function estimateSubAgentOutput(sa: SubAgentMessage): number {
  const chars = totalLength(sa.thinking) + totalLength(sa.text) + totalToolInputLength(sa.toolCalls)
  return Math.max(charsToTokens(chars), sa.tokenUsage?.output_tokens ?? 0)
}

// ── Turn-level cost helpers ──────────────────────────────────────────────────

/** Calculate cost for a turn using estimated output tokens. */
export function calculateTurnCostEstimated(turn: Turn): number {
  if (!turn.tokenUsage) return 0
  const u = turn.tokenUsage
  return calculateCost({
    model: turn.model,
    inputTokens: u.input_tokens,
    outputTokens: estimateTotalOutputTokens(turn),
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  })
}

/** Calculate cost for a sub-agent message using estimated output tokens. */
export function calculateSubAgentCostEstimated(sa: SubAgentMessage): number {
  if (!sa.tokenUsage) return 0
  const u = sa.tokenUsage
  return calculateCost({
    model: sa.model,
    inputTokens: u.input_tokens,
    outputTokens: estimateSubAgentOutput(sa),
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  })
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}
