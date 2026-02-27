/**
 * Session statistics computation — token usage aggregation and tool call tallying.
 */

import type { Turn, SessionStats, TokenUsage } from "./types"
import {
  calculateTurnCostEstimated,
  calculateSubAgentCostEstimated,
  estimateTotalOutputTokens,
  estimateSubAgentOutput,
} from "./token-costs"

export function mergeTokenUsage(
  existing: TokenUsage | null,
  incoming: TokenUsage
): TokenUsage {
  if (!existing) {
    return { ...incoming }
  }
  return {
    input_tokens: existing.input_tokens + incoming.input_tokens,
    output_tokens: existing.output_tokens + incoming.output_tokens,
    cache_creation_input_tokens:
      (existing.cache_creation_input_tokens ?? 0) +
      (incoming.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (existing.cache_read_input_tokens ?? 0) +
      (incoming.cache_read_input_tokens ?? 0),
  }
}

/**
 * Count tool calls in an array, accumulating into `counts` map.
 * Returns the number of errored tool calls.
 */
export function countToolCalls(
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

/** Alias for countToolCalls. */
export const tallyToolCalls = countToolCalls

export function addUsageToStats(
  stats: SessionStats,
  usage: { input_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
  estimatedOutput: number,
  cost: number,
): void {
  stats.totalInputTokens += usage.input_tokens
  stats.totalOutputTokens += estimatedOutput
  stats.totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0
  stats.totalCacheReadTokens += usage.cache_read_input_tokens ?? 0
  stats.totalCostUSD += cost
}

export function computeStats(turns: Turn[]): SessionStats {
  const stats: SessionStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUSD: 0,
    toolCallCounts: {},
    errorCount: 0,
    totalDurationMs: 0,
    turnCount: turns.length,
  }

  for (const turn of turns) {
    if (turn.tokenUsage) {
      addUsageToStats(stats, turn.tokenUsage, estimateTotalOutputTokens(turn), calculateTurnCostEstimated(turn))
    }
    if (turn.durationMs) stats.totalDurationMs += turn.durationMs
    stats.errorCount += countToolCalls(turn.toolCalls, stats.toolCallCounts)

    for (const sa of turn.subAgentActivity) {
      stats.errorCount += countToolCalls(sa.toolCalls, stats.toolCallCounts)
      if (sa.tokenUsage) {
        addUsageToStats(stats, sa.tokenUsage, estimateSubAgentOutput(sa), calculateSubAgentCostEstimated(sa))
      }
    }
  }

  return stats
}
