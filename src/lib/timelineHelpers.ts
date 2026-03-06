import type { Turn, TurnContentBlock, ToolCall, ThinkingBlock } from "@/lib/types"

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

/** Collect consecutive tool_calls blocks starting at `startIndex`. */
export function collectToolCalls(blocks: TurnContentBlock[], startIndex: number): { toolCalls: ToolCall[]; nextIndex: number } {
  const toolCalls: ToolCall[] = []
  let j = startIndex
  while (j < blocks.length && blocks[j].kind === "tool_calls") {
    toolCalls.push(...(blocks[j] as { kind: "tool_calls"; toolCalls: ToolCall[] }).toolCalls)
    j++
  }
  return { toolCalls, nextIndex: j }
}

/** Human-readable label for a count of tool calls. */
export function toolCallCountLabel(count: number): string {
  return `${count} tool call${count !== 1 ? "s" : ""}`
}

// ── Activity grouping (thinking + tool_calls) ──────────────────────────────

export type ActivityItem =
  | { kind: "thinking"; blocks: ThinkingBlock[] }
  | { kind: "tool_calls"; toolCalls: ToolCall[] }

/** Collect consecutive thinking + tool_calls blocks starting at `startIndex`. */
export function collectActivity(
  blocks: TurnContentBlock[],
  startIndex: number,
): { items: ActivityItem[]; toolCalls: ToolCall[]; thinkingCount: number; nextIndex: number } {
  const items: ActivityItem[] = []
  const allToolCalls: ToolCall[] = []
  let thinkingCount = 0
  let j = startIndex
  while (j < blocks.length) {
    const block = blocks[j]
    if (block.kind === "thinking") {
      items.push({ kind: "thinking", blocks: block.blocks })
      thinkingCount += block.blocks.length
      j++
    } else if (block.kind === "tool_calls") {
      items.push({ kind: "tool_calls", toolCalls: block.toolCalls })
      allToolCalls.push(...block.toolCalls)
      j++
    } else {
      break
    }
  }
  return { items, toolCalls: allToolCalls, thinkingCount, nextIndex: j }
}

/** Human-readable label for a mixed activity group. */
export function activityCountLabel(toolCallCount: number, thinkingCount: number): string {
  if (thinkingCount === 0) return toolCallCountLabel(toolCallCount)
  if (toolCallCount === 0) return `${thinkingCount} thinking block${thinkingCount !== 1 ? "s" : ""}`
  const total = toolCallCount + thinkingCount
  return `${total} action${total !== 1 ? "s" : ""}`
}
