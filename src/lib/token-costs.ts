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

import type { Turn, SubAgentMessage, TokenUsage } from "./types"

// ── Constants ─────────────────────────────────────────────────────────────────

/** Approximate characters per token for content-based estimation. */
export const CHARS_PER_TOKEN = 4

/** Total input tokens above this threshold trigger extended context pricing. */
const EXTENDED_CONTEXT_THRESHOLD = 200_000

// ── Pricing Tiers (per million tokens, USD) ──────────────────────────────────
//
// Source: Claude Code v2.1.53 binary (decompiled JS bundle).
// CC uses a model→tier mapping; each tier has five price points.

interface PricingTier {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  webSearch: number // per request, not per million
}

// Standard tiers
const TIER_HAIKU_35:         PricingTier = { input: 0.80, output: 4,     cacheWrite: 1,     cacheRead: 0.08, webSearch: 0.01 }
const TIER_HAIKU_45:         PricingTier = { input: 1,    output: 5,     cacheWrite: 1.25,  cacheRead: 0.10, webSearch: 0.01 }
const TIER_SONNET_LEGACY:    PricingTier = { input: 3,    output: 15,    cacheWrite: 3.75,  cacheRead: 0.30, webSearch: 0.01 }
const TIER_SONNET_LATEST:    PricingTier = { input: 5,    output: 25,    cacheWrite: 6.25,  cacheRead: 0.50, webSearch: 0.01 }
const TIER_OPUS_LEGACY:      PricingTier = { input: 15,   output: 75,    cacheWrite: 18.75, cacheRead: 1.50, webSearch: 0.01 }

// Extended context tiers (total input > 200k tokens)
const TIER_SONNET_LEGACY_EXT: PricingTier = { input: 6,   output: 22.5,  cacheWrite: 7.50,  cacheRead: 0.60, webSearch: 0.01 }
const TIER_EXTENDED:          PricingTier = { input: 10,   output: 37.5,  cacheWrite: 12.50, cacheRead: 1.00, webSearch: 0.01 }

// Model → tier mapping (matched from CC source)
//
// CC normalises full model IDs (e.g. "claude-opus-4-6-20260119") to a short
// key.  We match with `includes()` for robustness.
const MODEL_TIERS: Array<{ match: string; tier: PricingTier; extendedTier?: PricingTier }> = [
  // Haiku
  { match: "haiku-4-5",      tier: TIER_HAIKU_45 },
  { match: "haiku-4-0",      tier: TIER_HAIKU_35 },
  { match: "3-5-haiku",      tier: TIER_HAIKU_35 },
  // Sonnet latest (4.5+)
  { match: "sonnet-4-6",     tier: TIER_SONNET_LATEST, extendedTier: TIER_EXTENDED },
  { match: "sonnet-4-5",     tier: TIER_SONNET_LATEST, extendedTier: TIER_EXTENDED },
  // Sonnet legacy (3.5, 3.7, 4.0)
  { match: "sonnet-4-0",     tier: TIER_SONNET_LEGACY, extendedTier: TIER_SONNET_LEGACY_EXT },
  { match: "3-7-sonnet",     tier: TIER_SONNET_LEGACY, extendedTier: TIER_SONNET_LEGACY_EXT },
  { match: "3-5-sonnet",     tier: TIER_SONNET_LEGACY, extendedTier: TIER_SONNET_LEGACY_EXT },
  // Opus latest (4.5+) — same tier as sonnet latest
  { match: "opus-4-6",       tier: TIER_SONNET_LATEST, extendedTier: TIER_EXTENDED },
  { match: "opus-4-5",       tier: TIER_SONNET_LATEST, extendedTier: TIER_EXTENDED },
  // Opus legacy (4.0, 4.1)
  { match: "opus-4-1",       tier: TIER_OPUS_LEGACY },
  { match: "opus-4-0",       tier: TIER_OPUS_LEGACY },
]

// Fallback: sonnet-latest tier (matches CC's default for opus-4-6, the current default model)
const DEFAULT_TIER = TIER_SONNET_LATEST
const DEFAULT_EXTENDED_TIER = TIER_EXTENDED

// Generic fallbacks by model family (when no specific version matches)
const FAMILY_FALLBACKS: Array<{ match: string; tier: PricingTier }> = [
  { match: "haiku", tier: TIER_HAIKU_45 },
  { match: "sonnet", tier: TIER_SONNET_LATEST },
  { match: "opus", tier: TIER_SONNET_LATEST },
]

function resolveTier(model: string, totalInputTokens?: number): PricingTier {
  const isExtended = (totalInputTokens ?? 0) > EXTENDED_CONTEXT_THRESHOLD

  // Try specific model versions first
  for (const entry of MODEL_TIERS) {
    if (model.includes(entry.match)) {
      return (isExtended && entry.extendedTier) ? entry.extendedTier : entry.tier
    }
  }

  // Fall back to model family
  for (const entry of FAMILY_FALLBACKS) {
    if (model.includes(entry.match)) return entry.tier
  }

  return isExtended ? DEFAULT_EXTENDED_TIER : DEFAULT_TIER
}

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

// ── Breakdown Analytics ──────────────────────────────────────────────────────

export interface UsageBucket {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

function emptyBucket(): UsageBucket {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
}

function addToBucket(bucket: UsageBucket, usage: TokenUsage, model: string | null, estimatedOutput: number) {
  const cr = usage.cache_read_input_tokens ?? 0
  const cw = usage.cache_creation_input_tokens ?? 0
  bucket.input += usage.input_tokens
  bucket.output += estimatedOutput
  bucket.cacheRead += cr
  bucket.cacheWrite += cw
  bucket.cost += calculateCost({
    model,
    inputTokens: usage.input_tokens,
    outputTokens: estimatedOutput,
    cacheWriteTokens: cw,
    cacheReadTokens: cr,
  })
}

export interface AgentBreakdown {
  mainAgent: UsageBucket
  subAgents: UsageBucket
}

export function computeAgentBreakdown(turns: Turn[]): AgentBreakdown {
  const main = emptyBucket()
  const sub = emptyBucket()

  for (const turn of turns) {
    if (turn.tokenUsage) addToBucket(main, turn.tokenUsage, turn.model, estimateTotalOutputTokens(turn))
    for (const sa of turn.subAgentActivity) {
      if (sa.tokenUsage) addToBucket(sub, sa.tokenUsage, sa.model, estimateSubAgentOutput(sa))
    }
  }

  return { mainAgent: main, subAgents: sub }
}

export interface ModelBreakdown {
  model: string
  shortName: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export function computeModelBreakdown(turns: Turn[], shortenModel: (m: string) => string): ModelBreakdown[] {
  const map = new Map<string, ModelBreakdown>()

  function getEntry(model: string | null): ModelBreakdown {
    const key = model ?? "unknown"
    let entry = map.get(key)
    if (!entry) {
      entry = { model: key, shortName: shortenModel(key), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
      map.set(key, entry)
    }
    return entry
  }

  for (const turn of turns) {
    if (turn.tokenUsage) {
      const e = getEntry(turn.model)
      addToBucket(e, turn.tokenUsage, turn.model, estimateTotalOutputTokens(turn))
    }
    for (const sa of turn.subAgentActivity) {
      if (sa.tokenUsage) {
        const e = getEntry(sa.model)
        addToBucket(e, sa.tokenUsage, sa.model, estimateSubAgentOutput(sa))
      }
    }
  }

  return [...map.values()].sort((a, b) => b.cost - a.cost)
}

export interface CacheBreakdown {
  cacheRead: number
  cacheWrite: number
  newInput: number
  total: number
}

export function computeCacheBreakdown(turns: Turn[]): CacheBreakdown {
  let cacheRead = 0
  let cacheWrite = 0
  let newInput = 0

  function add(usage: TokenUsage) {
    cacheRead += usage.cache_read_input_tokens ?? 0
    cacheWrite += usage.cache_creation_input_tokens ?? 0
    newInput += usage.input_tokens
  }

  for (const turn of turns) {
    if (turn.tokenUsage) add(turn.tokenUsage)
    for (const sa of turn.subAgentActivity) {
      if (sa.tokenUsage) add(sa.tokenUsage)
    }
  }

  return { cacheRead, cacheWrite, newInput, total: cacheRead + cacheWrite + newInput }
}
