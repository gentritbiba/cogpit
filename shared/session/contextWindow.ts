/**
 * Context-window math.
 *
 * Shared so the server-side Mission Control summary and the client-side context
 * badge cannot disagree about how full a session is.
 */

/** Headroom Claude Code reserves before auto-compaction fires. */
export const AUTO_COMPACT_BUFFER = 33_000

const EXTENDED_CONTEXT_LIMIT = 1_000_000
const STANDARD_CONTEXT_LIMIT = 200_000

/**
 * Models whose context window is 200k. Everything else is treated as
 * current-generation (1M), so a model released after this list was written
 * reports the larger window rather than a stale small one.
 *
 * Deliberately not family-based: sonnet-4-5 is 200k while sonnet-4-6 is 1M,
 * and opus-4-5 is 200k while opus-4-6 and later are 1M. Source: LiteLLM
 * `max_input_tokens`, the same table the cost code prices against.
 */
const STANDARD_CONTEXT_MODELS = [
  "claude-haiku-4-5",
  "claude-haiku-4-1",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-opus-4-1",
]

export function getContextLimit(model: string): number {
  const normalized = model.trim().toLowerCase()
  // An explicit [1m] request wins over the model's default window.
  if (normalized.includes("[1m]")) return EXTENDED_CONTEXT_LIMIT
  // Provider-prefixed ids (`vertex_ai/…`, `bedrock/anthropic.…`) embed the
  // model name, so a substring match covers every spelling.
  const isStandard = STANDARD_CONTEXT_MODELS.some((id) => normalized.includes(id))
  return isStandard ? STANDARD_CONTEXT_LIMIT : EXTENDED_CONTEXT_LIMIT
}

/** Token counts reported by one assistant response. */
export interface ContextUsageInput {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface ContextUsage {
  used: number
  /** Hard context window limit (e.g. 200k) */
  limit: number
  /** Approximate threshold where auto-compact fires */
  compactAt: number
  /** Percentage of usable space consumed (0–100, relative to compactAt) */
  percent: number
  /** Percentage of absolute context window consumed */
  percentAbsolute: number
}

/**
 * Context pressure implied by a single assistant response.
 *
 * Each API call reports the FULL context window as input tokens, so the latest
 * response — not a sum across the session — is what the model is carrying.
 */
export function computeContextUsage(
  usage: ContextUsageInput,
  model: string,
): ContextUsage {
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0
  const cacheCreate =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0
  const used = input + cacheCreate + cacheRead
  const limit = getContextLimit(model)
  const compactAt = limit - AUTO_COMPACT_BUFFER
  return {
    used,
    limit,
    compactAt,
    percent: Math.min(100, (used / compactAt) * 100),
    percentAbsolute: Math.min(100, (used / limit) * 100),
  }
}
