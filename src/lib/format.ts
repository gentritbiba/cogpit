import type { RawMessage, Turn } from "../../shared/session/types"
import { computeContextUsage, type ContextUsage } from "../../shared/session/contextWindow"
import { descriptorForDirName } from "@/lib/agents"

export { shortenModel } from "../../shared/session/model-names"

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "—"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
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
  // Long-running sessions are routine, and "885m 12s" is unreadable.
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
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

/** Format a process age in seconds as "2d 3h", "3h 4m", or "5m". */
export function formatAge(seconds: number): string {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.max(1, Math.floor(seconds / 60))}m`
}

/**
 * Get the duration of a turn in ms.
 * Prefers `turn.durationMs` (summed from Claude Code's turn_duration system messages).
 * Falls back to the span of the turn's own timestamps.
 *
 * A background task can resume a turn hours after it went quiet, so the span is
 * taken per stretch of work and summed: the stretches are what the turn spent
 * working, the gaps between them are what it spent waiting.
 */
export function getTurnDuration(turn: Turn): number | null {
  if (turn.durationMs !== null) return turn.durationMs
  if (!turn.timestamp) return null

  let total = 0
  let start = turn.timestamp
  let end = ""

  const extend = (ts: string | undefined) => {
    if (ts && ts > end) end = ts
  }
  const closeStretch = () => {
    if (!end) return
    const diff = new Date(end).getTime() - new Date(start).getTime()
    if (diff > 0) total += diff
    end = ""
  }

  for (const block of turn.contentBlocks) {
    if (block.kind === "task_notification") {
      closeStretch()
      if (block.timestamp) start = block.timestamp
      continue
    }
    extend(block.timestamp)
    if (block.kind === "tool_calls" || block.kind === "plan_mode") {
      for (const tc of block.toolCalls) extend(tc.timestamp)
    }
  }
  closeStretch()

  return total > 0 ? total : null
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "..."
}

/**
 * Best-effort project path for a project directory name.
 *
 * Each agent encodes a cwd into a dirName differently, so the decode has to go
 * through the agent that owns the name — decoding a base64 payload with the
 * dash-separated scheme produces a plausible-looking path that points nowhere.
 * A dirName no agent can decode falls back to itself, which at least stays
 * recognisable in the UI; a caller holding the session's recorded `cwd` should
 * always prefer that, since the dash-separated encoding is lossy.
 */
export function dirNameToPath(dirName: string): string {
  return descriptorForDirName(dirName).dirName.decode(dirName) ?? dirName
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

export { getContextLimit } from "../../shared/session/contextWindow"

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
      return computeContextUsage(msg.message.usage, msg.message.model ?? "", "claude")
    }
  }
  return null
}
