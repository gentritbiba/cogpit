import type { RawMessage, Turn } from "./types"

export { calculateTurnCost, formatCost, computeAgentBreakdown, computeModelBreakdown, computeCacheBreakdown } from "./token-costs"

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
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString()
}

/**
 * Get the duration of a turn in ms.
 * Prefers `turn.durationMs` (set by Claude Code's turn_duration system message).
 * Falls back to computing the diff between the turn's first and last timestamps.
 */
export function getTurnDuration(turn: Turn): number | null {
  if (turn.durationMs !== null) return turn.durationMs
  if (!turn.timestamp) return null

  let lastTs = ""
  for (const tc of turn.toolCalls) {
    if (tc.timestamp && tc.timestamp > lastTs) lastTs = tc.timestamp
  }
  for (const block of turn.contentBlocks) {
    if (block.timestamp && block.timestamp > lastTs) lastTs = block.timestamp
  }
  if (!lastTs) return null

  const diff = new Date(lastTs).getTime() - new Date(turn.timestamp).getTime()
  return diff > 0 ? diff : null
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

/** If a path is inside a .worktrees directory, return the parent project path and worktree name. */
export function parseWorktreePath(fullPath: string): { parentPath: string; worktreeName: string } | null {
  const marker = "/.worktrees/"
  const idx = fullPath.indexOf(marker)
  if (idx === -1) return null
  const worktreeName = fullPath.slice(idx + marker.length).split("/")[0]
  if (!worktreeName) return null
  return { parentPath: fullPath.slice(0, idx), worktreeName }
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

const DEFAULT_CONTEXT_LIMIT = 200_000
const EXTENDED_CONTEXT_LIMIT = 1_000_000

/**
 * Models that support 1M extended context in Claude Code.
 * The API model field never includes "[1m]", and the system prompt hint is not
 * stored in session JSONL — so we cannot distinguish 200k from 1M sessions.
 * Default to 1M for models that support it, since most Claude Code users use
 * extended context and a 200k default produces misleading context percentages.
 */
const EXTENDED_CONTEXT_MODELS = ["opus-4-6", "sonnet-4-6", "opus-4-5", "sonnet-4-5"]

export function getContextLimit(model: string): number {
  if (model.includes("[1m]")) return EXTENDED_CONTEXT_LIMIT
  for (const m of EXTENDED_CONTEXT_MODELS) {
    if (model.includes(m)) return EXTENDED_CONTEXT_LIMIT
  }
  return DEFAULT_CONTEXT_LIMIT
}

/**
 * Detect the effective context limit for a session by scanning raw messages.
 *
 * Uses model-based detection (models that support 1M context default to 1M)
 * plus usage-based fallback (if any turn exceeds 200k tokens, it must be 1M).
 */
function detectContextLimit(rawMessages: readonly RawMessage[]): number {
  let maxUsed = 0
  let detectedModel = ""

  for (const msg of rawMessages) {
    if (msg.type === "assistant") {
      if (!detectedModel && msg.message.model) {
        detectedModel = msg.message.model
      }
      const u = msg.message.usage
      const input = typeof u.input_tokens === "number" ? u.input_tokens : 0
      const cacheCreate = typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0
      const cacheRead = typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0
      const total = input + cacheCreate + cacheRead
      if (total > maxUsed) maxUsed = total
    }
  }

  // Model-based detection
  if (detectedModel) {
    const modelLimit = getContextLimit(detectedModel)
    if (modelLimit === EXTENDED_CONTEXT_LIMIT) return EXTENDED_CONTEXT_LIMIT
  }

  // Usage-based fallback: if any turn exceeded 200k, must be 1M
  if (maxUsed > DEFAULT_CONTEXT_LIMIT) return EXTENDED_CONTEXT_LIMIT

  return DEFAULT_CONTEXT_LIMIT
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
      const limit = detectContextLimit(rawMessages)
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

