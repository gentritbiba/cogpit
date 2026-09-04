/**
 * Model rate lookup and cost arithmetic for raw API pricing.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` and T3 Code price against. Everything here is pure; fetching
 * and caching the table lives in `service.ts`.
 */
import type { UsageCostSource, UsageCostTokenTotals } from "../contracts/usageCost"

/** USD per token, including the context tier selected by each request. */
export interface ModelRate {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheReadCostPerToken: number
  cacheCreationCostPerToken: number
  /** Writes at the 1-hour TTL cost more than the default 5-minute one. */
  cacheCreation1hCostPerToken: number
  inputCostPerTokenAboveThreshold: number | null
  outputCostPerTokenAboveThreshold: number | null
  cacheReadCostPerTokenAboveThreshold: number | null
  cacheCreationCostPerTokenAboveThreshold: number | null
  longContextThresholdTokens: number | null
  /** OpenAI's non-200k tiers switch the whole request; legacy 200k fields are marginal. */
  longContextPricing: "wholeRequest" | "marginal"
  /** Multiplier for a transcript-recorded priority/fast request. */
  fastCostMultiplier: number
}

export type RateTable = ReadonlyMap<string, ModelRate>

export interface UsageCostBreakdown {
  uncachedInputUsd: number
  cachedInputUsd: number
  cacheCreationUsd: number
  outputUsd: number
}

export type UsageCostSpeed = "standard" | "fast" | null

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Ranks candidates for one normalized name. LiteLLM lists the same model under
 * many provider prefixes that all normalize together, and they disagree: some
 * resellers publish no cache rates at all. Carrying cache rates outranks
 * everything, since the alternative is charging cache reads at the full input
 * rate — a 10x overcharge on the token class that dominates agent traffic.
 * Exactness only breaks ties between equally complete entries.
 */
function entryRank(name: string, normalized: string, hasCacheRates: boolean): number {
  return (hasCacheRates ? 2 : 0) + (name === normalized ? 1 : 0)
}

interface TieredRate {
  cost: number
  thresholdTokens: number
}

function tieredRate(entry: Record<string, unknown>, baseKey: string): TieredRate | null {
  const escapedKey = baseKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`^${escapedKey}_above_(\\d+)k_tokens$`)
  for (const [key, value] of Object.entries(entry)) {
    const match = pattern.exec(key)
    const cost = finiteNumber(value)
    if (!match || cost === null) continue
    return { cost, thresholdTokens: Number(match[1]) * 1000 }
  }
  return null
}

function positiveRatio(numerator: number | null, denominator: number): number | null {
  if (numerator === null || numerator <= 0 || denominator <= 0) return null
  const ratio = numerator / denominator
  return Number.isFinite(ratio) && ratio >= 1 ? ratio : null
}

/**
 * Projects the LiteLLM document into a rate table. Entries without both an
 * input and an output rate are dropped: a half-priced model would silently
 * under-report cost, which is worse than reporting the model as unpriced.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>()
  const ranks = new Map<string, number>()
  if (typeof document !== "object" || document === null) return table

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue
    const entry = raw as Record<string, unknown>
    const input = finiteNumber(entry.input_cost_per_token)
    const output = finiteNumber(entry.output_cost_per_token)
    if (input === null || output === null) continue

    const cacheRead = finiteNumber(entry.cache_read_input_token_cost)
    const cacheCreation = finiteNumber(entry.cache_creation_input_token_cost)
    const inputTier = tieredRate(entry, "input_cost_per_token")
    const outputTier = tieredRate(entry, "output_cost_per_token")
    const cacheReadTier = tieredRate(entry, "cache_read_input_token_cost")
    const cacheCreationTier = tieredRate(entry, "cache_creation_input_token_cost")
    const threshold = inputTier?.thresholdTokens
      ?? outputTier?.thresholdTokens
      ?? cacheReadTier?.thresholdTokens
      ?? cacheCreationTier?.thresholdTokens
      ?? null
    const normalized = normalizeModelName(name)
    const fastMultiplier = positiveRatio(
      finiteNumber(entry.input_cost_per_token_priority),
      input,
    ) ?? positiveRatio(
      finiteNumber(entry.output_cost_per_token_priority),
      output,
    ) ?? 1

    const rank = entryRank(name.trim().toLowerCase(), normalized, cacheRead !== null)
    // Ties keep the first entry seen, so the table does not depend on where
    // LiteLLM happens to append new aliases.
    if (rank <= (ranks.get(normalized) ?? -1)) continue
    ranks.set(normalized, rank)

    table.set(normalized, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      // Anthropic bills cache reads at a discount and cache writes at a
      // premium. When a model omits them, cached input is priced as plain
      // input rather than as free.
      cacheReadCostPerToken: cacheRead ?? input,
      cacheCreationCostPerToken: cacheCreation ?? input,
      // Models that sell only one cache TTL publish no premium rate.
      cacheCreation1hCostPerToken:
        finiteNumber(entry.cache_creation_input_token_cost_above_1hr) ?? cacheCreation ?? input,
      inputCostPerTokenAboveThreshold: inputTier?.cost ?? null,
      outputCostPerTokenAboveThreshold: outputTier?.cost ?? null,
      cacheReadCostPerTokenAboveThreshold: cacheReadTier?.cost ?? null,
      cacheCreationCostPerTokenAboveThreshold: cacheCreationTier?.cost ?? null,
      longContextThresholdTokens: threshold,
      longContextPricing: threshold !== null && threshold !== 200_000 ? "wholeRequest" : "marginal",
      fastCostMultiplier: fastMultiplier,
    })
  }
  return table
}

/**
 * Canonicalises a model name for lookup: strips a `provider/` prefix (LiteLLM
 * publishes both `claude-x` and `anthropic/claude-x`), a trailing `[1m]`-style
 * context-window suffix, and lowercases.
 */
export function normalizeModelName(model: string): string {
  const trimmed = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "")
  const slash = trimmed.lastIndexOf("/")
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * Models we never price. `<synthetic>` marks locally generated messages that
 * were never billed; bare family names are ambiguous across generations, so
 * they report as unpriced instead of guessing a generation.
 */
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
])

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const normalized = normalizeModelName(model)
  if (normalized.length === 0 || UNPRICEABLE_MODELS.has(normalized)) return null
  return table.get(normalized) ?? null
}

/**
 * Which context tier a request falls into is a property of the whole request,
 * so resolve it once and price each token class against the result.
 */
function contextTierPricer(
  rate: ModelRate,
  totals: UsageCostTokenTotals,
): (tokens: number, base: number, above: number | null) => number {
  const threshold = rate.longContextThresholdTokens
  const contextTokens =
    totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens
  const wholeRequestIsLong = threshold !== null && contextTokens > threshold

  return function tierCost(tokens, base, above) {
    if (tokens <= 0) return 0
    if (above === null || threshold === null) return tokens * base
    if (rate.longContextPricing === "wholeRequest") {
      return tokens * (wholeRequestIsLong ? above : base)
    }
    if (tokens <= threshold) return tokens * base
    return threshold * base + (tokens - threshold) * above
  }
}

/** Sum of the priced token classes. */
export function totalUsageCostBreakdown(breakdown: UsageCostBreakdown): number {
  return breakdown.uncachedInputUsd
    + breakdown.cachedInputUsd
    + breakdown.cacheCreationUsd
    + breakdown.outputUsd
}

/** Prices each billable token class separately, or returns null for an unknown model. */
export function usageCostBreakdown(
  table: RateTable,
  model: string,
  totals: UsageCostTokenTotals,
  speed: UsageCostSpeed = null,
): UsageCostBreakdown | null {
  const rate = lookupRate(table, model)
  if (rate === null) return null

  const cacheCreation1h = Math.min(totals.cacheCreation1hTokens, totals.cacheCreationTokens)
  const cacheCreation5m = totals.cacheCreationTokens - cacheCreation1h
  const tierCost = contextTierPricer(rate, totals)
  const multiplier = speed === "fast" ? rate.fastCostMultiplier : 1

  return {
    uncachedInputUsd: multiplier * tierCost(
      totals.uncachedInputTokens,
      rate.inputCostPerToken,
      rate.inputCostPerTokenAboveThreshold,
    ),
    cachedInputUsd: multiplier * tierCost(
      totals.cachedInputTokens,
      rate.cacheReadCostPerToken,
      rate.cacheReadCostPerTokenAboveThreshold,
    ),
    cacheCreationUsd: multiplier * (
      tierCost(
        cacheCreation5m,
        rate.cacheCreationCostPerToken,
        rate.cacheCreationCostPerTokenAboveThreshold,
      )
      + cacheCreation1h * rate.cacheCreation1hCostPerToken
    ),
    outputUsd: multiplier * tierCost(
      totals.outputTokens,
      rate.outputCostPerToken,
      rate.outputCostPerTokenAboveThreshold,
    ),
  }
}

/**
 * Prices a record's tokens. `reasoningTokens` is not charged separately: it is
 * already counted inside `outputTokens`.
 */
export function priceUsage(
  table: RateTable,
  model: string,
  totals: UsageCostTokenTotals,
  reportedCostUsd: number | null,
  speed: UsageCostSpeed = null,
): { costUsd: number; costSource: UsageCostSource } {
  if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" }
  }

  const breakdown = usageCostBreakdown(table, model, totals, speed)
  if (breakdown === null) return { costUsd: 0, costSource: "unpriced" }
  return { costUsd: totalUsageCostBreakdown(breakdown), costSource: "modelPriced" }
}

/**
 * What the cached input would have cost at full input rates, minus what it
 * actually cost. Drives the "cache savings" figure.
 */
export function cacheSavingsUsd(
  table: RateTable,
  model: string,
  totals: UsageCostTokenTotals,
  speed: UsageCostSpeed = null,
): number {
  const rate = lookupRate(table, model)
  if (rate === null) return 0
  const tierCost = contextTierPricer(rate, totals)
  const fullInputCost = tierCost(
    totals.cachedInputTokens,
    rate.inputCostPerToken,
    rate.inputCostPerTokenAboveThreshold,
  )
  const cachedInputCost = tierCost(
    totals.cachedInputTokens,
    rate.cacheReadCostPerToken,
    rate.cacheReadCostPerTokenAboveThreshold,
  )
  const multiplier = speed === "fast" ? rate.fastCostMultiplier : 1
  return Math.max(0, multiplier * (fullInputCost - cachedInputCost))
}
