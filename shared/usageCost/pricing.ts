/**
 * Model rate lookup and cost arithmetic for raw API pricing.
 *
 * Rates come from LiteLLM's `model_prices_and_context_window.json`, the same
 * table `ccusage` and T3 Code price against. Everything here is pure; fetching
 * and caching the table lives in `service.ts`.
 */
import type { UsageCostSource, UsageCostTokenTotals } from "../contracts/usageCost"

/** USD per token. Tiered LiteLLM variants are deliberately ignored: the
 * transcripts don't record which tier served a request. */
export interface ModelRate {
  inputCostPerToken: number
  outputCostPerToken: number
  cacheReadCostPerToken: number
  cacheCreationCostPerToken: number
}

export type RateTable = ReadonlyMap<string, ModelRate>

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Projects the LiteLLM document into a rate table. Entries without both an
 * input and an output rate are dropped: a half-priced model would silently
 * under-report cost, which is worse than reporting the model as unpriced.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>()
  if (typeof document !== "object" || document === null) return table

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue
    const entry = raw as Record<string, unknown>
    const input = finiteNumber(entry.input_cost_per_token)
    const output = finiteNumber(entry.output_cost_per_token)
    if (input === null || output === null) continue

    table.set(normalizeModelName(name), {
      inputCostPerToken: input,
      outputCostPerToken: output,
      // Anthropic bills cache reads at a discount and cache writes at a
      // premium. When a model omits them, cached input is priced as plain
      // input rather than as free.
      cacheReadCostPerToken: finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken: finiteNumber(entry.cache_creation_input_token_cost) ?? input,
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
 * Prices a record's tokens. `reasoningTokens` is not charged separately: it is
 * already counted inside `outputTokens`.
 */
export function priceUsage(
  table: RateTable,
  model: string,
  totals: UsageCostTokenTotals,
  reportedCostUsd: number | null,
): { costUsd: number; costSource: UsageCostSource } {
  if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" }
  }

  const rate = lookupRate(table, model)
  if (rate === null) return { costUsd: 0, costSource: "unpriced" }

  const costUsd =
    totals.uncachedInputTokens * rate.inputCostPerToken
    + totals.cachedInputTokens * rate.cacheReadCostPerToken
    + totals.cacheCreationTokens * rate.cacheCreationCostPerToken
    + totals.outputTokens * rate.outputCostPerToken

  return { costUsd, costSource: "modelPriced" }
}

/**
 * What the cached input would have cost at full input rates, minus what it
 * actually cost. Drives the "cache savings" figure.
 */
export function cacheSavingsUsd(
  table: RateTable,
  model: string,
  totals: UsageCostTokenTotals,
): number {
  const rate = lookupRate(table, model)
  if (rate === null) return 0
  return totals.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken)
}
