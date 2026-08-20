/**
 * Raw API cost reporting contract.
 *
 * The server scans the provider CLIs' own on-disk transcripts
 * (`~/.claude/projects/**\/*.jsonl`, `~/.codex/sessions/**\/*.jsonl`) and prices
 * the tokens against LiteLLM's public rate table, the same approach `ccusage`
 * and T3 Code take. `costUsd` is the raw API-equivalent price of the tokens —
 * not money actually spent; subscription plans bill separately.
 */

export type UsageCostProvider = "claude" | "codex"

/**
 * Why a bucket's cost is what it is.
 *
 * - `providerReported` — the transcript carried an explicit `costUSD` figure.
 * - `modelPriced` — the model matched the LiteLLM rate table.
 * - `unpriced` — tokens are known, rates are not; counted in token totals but
 *   contributing nothing to `costUsd`.
 */
export type UsageCostSource = "providerReported" | "modelPriced" | "unpriced"

/**
 * Token counts for a bucket. `cachedInputTokens` and `cacheCreationTokens` are
 * disjoint from `uncachedInputTokens`; summing all three gives total input.
 * `reasoningTokens` is a subset of `outputTokens` and must never be added on top.
 */
export interface UsageCostTokenTotals {
  uncachedInputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
  reasoningTokens: number
}

/** One `(day, provider, model)` cell. `day` is `YYYY-MM-DD` in the request tz. */
export interface UsageCostBucket {
  day: string
  provider: UsageCostProvider
  model: string
  totals: UsageCostTokenTotals
  costUsd: number
  /** What the cached input would have cost at full input rates, minus actual. */
  cacheSavingsUsd: number
  costSource: UsageCostSource
  /** Distinct assistant responses, after de-duplication. */
  records: number
  /** Distinct transcript sessions that contributed to this cell. */
  sessions: number
}

export type UsageCostPricingStatus = "fresh" | "cached" | "unavailable"

export interface UsageCostSummary {
  /** Inclusive window, `YYYY-MM-DD` in `timeZone`. */
  sinceDay: string
  untilDay: string
  timeZone: string
  buckets: UsageCostBucket[]
  pricing: {
    status: UsageCostPricingStatus
    knownModels: number
    fetchedAt: string | null
  }
  scannedFiles: number
  /** Distinct sessions across the whole window (bucket counts overlap). */
  distinctSessions: number
  scanDurationMs: number
}

export function emptyUsageCostTotals(): UsageCostTokenTotals {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  }
}

export function addUsageCostTotals(
  a: UsageCostTokenTotals,
  b: UsageCostTokenTotals,
): UsageCostTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  }
}

/** Total processed tokens. reasoningTokens is inside outputTokens already. */
export function totalUsageCostTokens(totals: UsageCostTokenTotals): number {
  return (
    totals.uncachedInputTokens
    + totals.cachedInputTokens
    + totals.cacheCreationTokens
    + totals.outputTokens
  )
}
