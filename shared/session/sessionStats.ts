// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Session statistics computation — token usage aggregation and tool call tallying.
 *
 * Token totals are the raw figures the transcript reports. Costs are not
 * computed here: pricing needs the live LiteLLM rate table, which callers
 * apply via shared/usageCost/pricing.ts.
 */

import type { Turn, SessionStats, TokenUsage } from "./types"

/**
 * Count tool calls in an array, accumulating into `counts` map.
 * Returns the number of errored tool calls.
 */
function countToolCalls(
  toolCalls: readonly { name: string; isError: boolean }[],
  counts: Record<string, number>,
): number {
  let errors = 0
  for (const tc of toolCalls) {
    counts[tc.name] = (counts[tc.name] ?? 0) + 1
    if (tc.isError) errors++
  }
  return errors
}

function addUsageToStats(
  stats: SessionStats,
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  },
): void {
  stats.totalInputTokens += usage.input_tokens
  stats.totalOutputTokens += usage.output_tokens
  stats.totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0
  stats.totalCacheReadTokens += usage.cache_read_input_tokens ?? 0
}

export function createEmptySessionStats(turnCount: number): SessionStats {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    toolCallCounts: {},
    errorCount: 0,
    totalDurationMs: 0,
    turnCount,
  }
}

export function computeStats(turns: Turn[]): SessionStats {
  const stats = createEmptySessionStats(turns.length)

  for (const turn of turns) {
    if (turn.tokenUsage) addUsageToStats(stats, turn.tokenUsage)
    if (turn.durationMs) stats.totalDurationMs += turn.durationMs
    stats.errorCount += countToolCalls(turn.toolCalls, stats.toolCallCounts)

    for (const sa of turn.subAgentActivity) {
      stats.errorCount += countToolCalls(sa.toolCalls, stats.toolCallCounts)
      if (sa.tokenUsage) addUsageToStats(stats, sa.tokenUsage)
    }
  }

  return stats
}

export function mergeTokenUsage(existing: TokenUsage | null, incoming: TokenUsage): TokenUsage {
  if (!existing) return { ...incoming }
  // Thinking tokens are a slice of output_tokens, so they add up the same way.
  const thinking =
    (existing.output_tokens_details?.thinking_tokens ?? 0) +
    (incoming.output_tokens_details?.thinking_tokens ?? 0)
  return {
    input_tokens: existing.input_tokens + incoming.input_tokens,
    output_tokens: existing.output_tokens + incoming.output_tokens,
    cache_creation_input_tokens:
      (existing.cache_creation_input_tokens ?? 0) + (incoming.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (existing.cache_read_input_tokens ?? 0) + (incoming.cache_read_input_tokens ?? 0),
    speed: incoming.speed ?? existing.speed,
    ...(existing.output_tokens_details || incoming.output_tokens_details
      ? { output_tokens_details: { thinking_tokens: thinking } }
      : {}),
  }
}
