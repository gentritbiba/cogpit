// Facade over the shared raw-API pricing core, plus session-shaped adapters.
import type { TokenUsage } from "../../shared/session/types"
import { priceUsage, type RateTable } from "../../shared/usageCost/pricing"

export * from "../../shared/usageCost/pricing"
export * from "../../shared/contracts/usageCost"

/**
 * Prices a transcript usage object at raw API rates. Returns 0 when the model
 * is unknown to the rate table — surfaces hide zero costs rather than showing
 * a made-up number.
 */
export function priceTokenUsage(
  rates: RateTable,
  model: string | null,
  usage: TokenUsage,
): number {
  if (!model) return 0
  const { costUsd, costSource } = priceUsage(
    rates,
    model,
    {
      uncachedInputTokens: usage.input_tokens,
      cachedInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      // Per-turn usage carries no cache-TTL split, so the whole write prices at
      // the 5m rate. The usage dialog reads the transcripts directly and does
      // charge the 1h premium.
      cacheCreation1hTokens: 0,
      outputTokens: usage.output_tokens,
      reasoningTokens: 0,
    },
    null,
  )
  return costSource === "unpriced" ? 0 : costUsd
}
