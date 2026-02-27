/**
 * Token usage breakdown analytics — agent, model, and cache breakdowns.
 */

import type { Turn, TokenUsage } from "./types"
import { calculateCost } from "./token-costs"
import { estimateTotalOutputTokens, estimateSubAgentOutput } from "./token-costs"

// ── Bucket helpers ───────────────────────────────────────────────────────────

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

// ── Agent Breakdown ──────────────────────────────────────────────────────────

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

// ── Model Breakdown ──────────────────────────────────────────────────────────

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

// ── Cache Breakdown ──────────────────────────────────────────────────────────

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
