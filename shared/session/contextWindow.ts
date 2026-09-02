/**
 * Context-window math.
 *
 * Shared so the server-side Mission Control summary and the client-side context
 * badge cannot disagree about how full a session is.
 *
 * Both the window and the compaction reserve come from the agent's descriptor:
 * they are properties of the CLI, not of Cogpit. Applying one agent's reserve to
 * another's window is what used to make every Codex and Copilot session report a
 * 1M window with Claude Code's 33k auto-compaction headroom subtracted.
 */
import { descriptorFor, type AgentKind } from "./agent-descriptors"

/** Headroom Claude Code reserves before auto-compaction fires. */
export const AUTO_COMPACT_BUFFER = descriptorFor("claude").contextWindow.compactBuffer

export function getContextLimit(model: string, kind: AgentKind): number {
  const { defaultLimit, limits, extendedContext } = descriptorFor(kind).contextWindow
  const normalized = model.trim().toLowerCase()
  // An explicit extended-context request wins over the model's default window.
  if (extendedContext && normalized.includes(extendedContext.marker)) return extendedContext.limit
  // Provider-prefixed ids (`vertex_ai/…`, `bedrock/anthropic.…`) embed the
  // model name, so a substring match covers every spelling.
  return limits.find((entry) => normalized.includes(entry.match))?.limit ?? defaultLimit
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
  kind: AgentKind,
): ContextUsage {
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0
  const cacheCreate =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0
  const used = input + cacheCreate + cacheRead
  const limit = getContextLimit(model, kind)
  const compactAt = limit - descriptorFor(kind).contextWindow.compactBuffer
  return {
    used,
    limit,
    compactAt,
    percent: Math.min(100, (used / compactAt) * 100),
    percentAbsolute: Math.min(100, (used / limit) * 100),
  }
}
