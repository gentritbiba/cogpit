import type { RawMessage } from "./types"

// Re-export everything from the consolidated token-costs library
export {
  calculateCost,
  calculateTurnCost,
  calculateTurnCostEstimated,
  calculateSubAgentCostEstimated,
  estimateThinkingTokens,
  estimateVisibleOutputTokens,
  estimateTotalOutputTokens,
  estimateSubAgentOutput,
  formatCost,
  computeAgentBreakdown,
  computeModelBreakdown,
  computeCacheBreakdown,
  CHARS_PER_TOKEN,
} from "./token-costs"
export type {
  CostInput,
  AgentBreakdown,
  ModelBreakdown,
  CacheBreakdown,
  UsageBucket,
} from "./token-costs"

export function shortenModel(model: string): string {
  if (!model) return "unknown"
  if (model.includes("opus-4-6")) return "opus 4.6"
  if (model.includes("opus-4-5")) return "opus 4.5"
  if (model.includes("sonnet-4-6")) return "sonnet 4.6"
  if (model.includes("sonnet-4-5")) return "sonnet 4.5"
  if (model.includes("haiku-4-5")) return "haiku 4.5"
  if (model.includes("opus-4-0")) return "opus 4"
  if (model.includes("sonnet-4-0")) return "sonnet 4"
  if (model.includes("opus")) return "opus"
  if (model.includes("sonnet")) return "sonnet"
  if (model.includes("haiku")) return "haiku"
  return model.length > 20 ? model.slice(0, 20) + "..." : model
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

/** Format a number of seconds as a compact elapsed string (e.g. "42s", "2m 5s"). */
export function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)}KB`
  return `${bytes}B`
}

export function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "..."
}

export function dirNameToPath(dirName: string): string {
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/")
}

/** Show the last N segments of a filesystem path. */
export function shortPath(fullPath: string, segments = 2): string {
  const parts = fullPath.replace(/\/+$/, "").split("/").filter(Boolean)
  if (parts.length <= segments) return fullPath
  return parts.slice(-segments).join("/")
}

/** Return just the final folder name from a filesystem path. */
export function projectName(path: string): string {
  return path.replace(/\/+$/, "").split("/").at(-1) ?? path
}

/** Parse a sub-agent session fileName, returning parent + agent info or null. */
export function parseSubAgentPath(fileName: string): {
  parentSessionId: string
  agentId: string
  parentFileName: string
} | null {
  const match = fileName.match(/^([^/]+)\/subagents\/agent-([^.]+)\.jsonl$/)
  if (!match) return null
  return {
    parentSessionId: match[1],
    agentId: match[2],
    parentFileName: `${match[1]}.jsonl`,
  }
}

// ── Context Window ────────────────────────────────────────────────────────

// Auto-compact reserves ~33k tokens as buffer before the hard limit.
// Compaction fires at roughly (limit - buffer), not at the absolute limit.
const AUTO_COMPACT_BUFFER = 33_000

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "opus": 200_000,
  "sonnet": 200_000,
  "haiku": 200_000,
}

export function getContextLimit(model: string): number {
  for (const key of Object.keys(MODEL_CONTEXT_LIMITS)) {
    if (model.includes(key)) return MODEL_CONTEXT_LIMITS[key]
  }
  return 200_000
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
 * Get the current context usage from the last API response in the session.
 *
 * Each API call reports the FULL context window as input tokens.
 * A single turn can have multiple API calls (thinking → tool_use → more thinking),
 * and mergeTokenUsage sums them — which is correct for billing but wrong for
 * context size. We need the LAST raw API response's usage, not the merged turn total.
 */
export function getContextUsage(
  rawMessages: readonly RawMessage[]
): ContextUsage | null {
  // Walk backwards through raw messages to find the last assistant message with usage
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i]
    if (msg.type === "assistant") {
      const u = msg.message.usage
      const input = typeof u.input_tokens === "number" ? u.input_tokens : 0
      const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0
      const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0
      const used = input + cacheCreate + cacheRead
      const limit = getContextLimit(msg.message.model ?? "")
      const compactAt = limit - AUTO_COMPACT_BUFFER
      return {
        used,
        limit,
        compactAt,
        percent: Math.min(100, (used / compactAt) * 100),
        percentAbsolute: Math.min(100, (used / limit) * 100),
      }
    }
  }
  return null
}

