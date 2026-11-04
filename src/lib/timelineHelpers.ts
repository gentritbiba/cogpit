import type { Turn, TurnContentBlock, ToolCall, ThinkingBlock } from "../../shared/session/types"

/** Check whether any part of a turn matches a search query. */
export function matchesSearch(turn: Turn, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()

  if (turn.userMessage) {
    const text =
      typeof turn.userMessage === "string"
        ? turn.userMessage
        : JSON.stringify(turn.userMessage)
    if (text.toLowerCase().includes(q)) return true
  }

  for (const t of turn.assistantText) {
    if (t.toLowerCase().includes(q)) return true
  }

  for (const block of turn.contentBlocks) {
    if (block.kind === "queued_prompt" && block.content.toLowerCase().includes(q)) {
      return true
    }
    if (
      block.kind === "agent_message" &&
      (block.sender.toLowerCase().includes(q) || block.body.toLowerCase().includes(q))
    ) {
      return true
    }
  }

  for (const tb of turn.thinking) {
    if (tb.thinking.toLowerCase().includes(q)) return true
  }

  for (const tc of turn.toolCalls) {
    if (tc.name.toLowerCase().includes(q)) return true
    if (JSON.stringify(tc.input).toLowerCase().includes(q)) return true
    if (tc.result?.toLowerCase().includes(q)) return true
  }

  return false
}

// ── Activity grouping (thinking + tool_calls) ──────────────────────────────

export type ActivityItem =
  | { kind: "thinking"; blocks: ThinkingBlock[]; thoughtForMs?: number }
  | { kind: "tool_calls"; toolCalls: ToolCall[] }

/** Upper bound on a single thinking block's attributed duration (10 minutes). */
const MAX_THINKING_BLOCK_MS = 600_000

/**
 * Time attributed to a thinking block: the gap between it and the preceding
 * block, matching how Claude Code derives "Thought for Xs".
 */
function thinkingGapMs(
  blocks: TurnContentBlock[],
  index: number,
): number {
  const current = blocks[index].timestamp
  const previous = index > 0 ? blocks[index - 1].timestamp : undefined
  if (!current || !previous) return 0
  const delta = Date.parse(current) - Date.parse(previous)
  if (!Number.isFinite(delta) || delta <= 0) return 0
  return Math.min(delta, MAX_THINKING_BLOCK_MS)
}

/** Collect consecutive thinking + tool_calls blocks starting at `startIndex`. */
export function collectActivity(
  blocks: TurnContentBlock[],
  startIndex: number,
): {
  items: ActivityItem[]
  toolCalls: ToolCall[]
  thinkingCount: number
  thoughtForMs: number
  nextIndex: number
} {
  const items: ActivityItem[] = []
  const allToolCalls: ToolCall[] = []
  let thinkingCount = 0
  let thoughtForMs = 0
  let j = startIndex
  while (j < blocks.length) {
    const block = blocks[j]
    if (block.kind === "thinking") {
      const ms = thinkingGapMs(blocks, j)
      items.push({ kind: "thinking", blocks: block.blocks, thoughtForMs: ms })
      thinkingCount += block.blocks.length
      thoughtForMs += ms
      j++
    } else if (block.kind === "tool_calls") {
      items.push({ kind: "tool_calls", toolCalls: block.toolCalls })
      allToolCalls.push(...block.toolCalls)
      j++
    } else {
      break
    }
  }
  return { items, toolCalls: allToolCalls, thinkingCount, thoughtForMs, nextIndex: j }
}

export type ActivitySegment =
  | { kind: "activity"; items: ActivityItem[]; toolCalls: ToolCall[]; thinkingCount: number; thoughtForMs: number }
  | { kind: "spawn"; toolCall: ToolCall }

/**
 * A run of activity cut where a call starts another session: those calls
 * stand on their own, as the sessions they started, and the work on either
 * side stays grouped.
 */
export function segmentActivity(items: readonly ActivityItem[], isSpawn: (toolCall: ToolCall) => boolean): ActivitySegment[] {
  const segments: ActivitySegment[] = []
  let current: Extract<ActivitySegment, { kind: "activity" }> | null = null
  const open = () => {
    if (!current) {
      current = { kind: "activity", items: [], toolCalls: [], thinkingCount: 0, thoughtForMs: 0 }
      segments.push(current)
    }
    return current
  }
  for (const item of items) {
    if (item.kind === "thinking") {
      const segment = open()
      segment.items.push(item)
      segment.thinkingCount += item.blocks.length
      segment.thoughtForMs += item.thoughtForMs ?? 0
      continue
    }
    let run: ToolCall[] = []
    const flush = () => {
      if (run.length === 0) return
      const segment = open()
      segment.items.push({ kind: "tool_calls", toolCalls: run })
      segment.toolCalls.push(...run)
      run = []
    }
    for (const toolCall of item.toolCalls) {
      if (!isSpawn(toolCall)) {
        run.push(toolCall)
        continue
      }
      flush()
      segments.push({ kind: "spawn", toolCall })
      current = null
    }
    flush()
  }
  return segments
}
