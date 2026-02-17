export function shortenModel(model: string): string {
  if (!model) return "unknown"
  if (model.includes("opus-4-6")) return "opus 4.6"
  if (model.includes("opus-4-5")) return "opus 4.5"
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

// ── Cost Calculation ──────────────────────────────────────────────────────

// Pricing per million tokens (USD)
interface ModelPricing {
  input: number
  output: number
  cacheRead: number   // typically 0.1x input
  cacheWrite: number  // typically 1.25x input
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "opus-4-6":   { input: 15,  output: 75,  cacheRead: 1.5,   cacheWrite: 18.75 },
  "opus-4-5":   { input: 15,  output: 75,  cacheRead: 1.5,   cacheWrite: 18.75 },
  "opus-4-0":   { input: 15,  output: 75,  cacheRead: 1.5,   cacheWrite: 18.75 },
  "sonnet-4-5": { input: 3,   output: 15,  cacheRead: 0.3,   cacheWrite: 3.75  },
  "sonnet-4-0": { input: 3,   output: 15,  cacheRead: 0.3,   cacheWrite: 3.75  },
  "haiku-4-5":  { input: 0.8, output: 4,   cacheRead: 0.08,  cacheWrite: 1     },
  "haiku-4-0":  { input: 0.8, output: 4,   cacheRead: 0.08,  cacheWrite: 1     },
}

// Fallback: opus pricing (most conservative)
const DEFAULT_PRICING: ModelPricing = MODEL_PRICING["opus-4-6"]

function getPricing(model: string): ModelPricing {
  for (const key of Object.keys(MODEL_PRICING)) {
    if (model.includes(key)) return MODEL_PRICING[key]
  }
  return DEFAULT_PRICING
}

export function calculateTurnCost(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number {
  const p = getPricing(model ?? "")
  return (
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output +
    (cacheCreationTokens / 1_000_000) * p.cacheWrite +
    (cacheReadTokens / 1_000_000) * p.cacheRead
  )
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawMessages: readonly any[]
): ContextUsage | null {
  // Walk backwards through raw messages to find the last assistant message with usage
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i]
    if (msg.type === "assistant" && msg.message?.usage) {
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
