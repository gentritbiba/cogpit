// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Attribution statistics — what drove a session's turns, and what it cost.
 *
 * Claude Code 2.1.17x+ tags assistant records with the skill, plugin, MCP
 * server/tool, or subagent type behind them. This module folds those tags into
 * per-name buckets so the stats panel stays presentational.
 *
 * Token conventions, matching the rest of the stats surface:
 * - `inputTokens` is new input + cache reads + cache writes, the same total
 *   `InputOutputChart` draws as a turn's input bar. Cache reads dominate real
 *   transcripts, so excluding them would rank buckets by an amount nobody pays
 *   for or sees anywhere else in the panel.
 * - `outputTokens` is the raw `output_tokens`; the thinking slice is already
 *   inside it (see `TokenUsage.output_tokens_details`).
 * - A turn with no `tokenUsage` still counts as a turn, contributing 0 tokens.
 */

import type { Turn } from "./types"

export type AttributionDimension = "agent" | "skill" | "plugin" | "mcpServer" | "mcpTool"

/** Fixed order, most-populated dimension first — matches the local corpus. */
export const ATTRIBUTION_DIMENSIONS: readonly AttributionDimension[] = [
  "agent",
  "skill",
  "plugin",
  "mcpServer",
  "mcpTool",
]

export const ATTRIBUTION_DIMENSION_LABELS: Record<AttributionDimension, string> = {
  agent: "Agents",
  skill: "Skills",
  plugin: "Plugins",
  mcpServer: "MCP servers",
  mcpTool: "MCP tools",
}

/**
 * Name of the bucket collecting turns the CLI attributed nothing to for the
 * requested dimension. It is included rather than dropped: a skill's 6k turns
 * mean something different against 10k total than against 500k. It is pinned
 * last regardless of size, because it is almost always the largest bucket and
 * leading with it would bury the answer the panel exists to give.
 */
export const UNATTRIBUTED_BUCKET = "Unattributed"

export interface AttributionBucket {
  name: string
  turns: number
  inputTokens: number
  outputTokens: number
  isUnattributed: boolean
}

function totalTokens(bucket: AttributionBucket): number {
  return bucket.inputTokens + bucket.outputTokens
}

export function aggregateAttribution(
  turns: readonly Turn[],
  dimension: AttributionDimension,
): AttributionBucket[] {
  const buckets = new Map<string, AttributionBucket>()

  for (const turn of turns) {
    const name = turn.attribution?.[dimension] ?? UNATTRIBUTED_BUCKET
    let bucket = buckets.get(name)
    if (!bucket) {
      bucket = {
        name,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        isUnattributed: name === UNATTRIBUTED_BUCKET,
      }
      buckets.set(name, bucket)
    }

    bucket.turns += 1
    const usage = turn.tokenUsage
    if (usage) {
      bucket.inputTokens +=
        usage.input_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      bucket.outputTokens += usage.output_tokens
    }
  }

  const unattributed = buckets.get(UNATTRIBUTED_BUCKET)
  if (unattributed) buckets.delete(UNATTRIBUTED_BUCKET)

  const sorted = [...buckets.values()].sort((a, b) => totalTokens(b) - totalTokens(a))
  if (unattributed) sorted.push(unattributed)
  return sorted
}

/** The dimensions at least one turn was attributed to, in canonical order. */
export function attributedDimensions(turns: readonly Turn[]): AttributionDimension[] {
  return ATTRIBUTION_DIMENSIONS.filter((dimension) =>
    turns.some((turn) => turn.attribution?.[dimension]),
  )
}
