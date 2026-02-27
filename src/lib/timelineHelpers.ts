import type { Turn, TurnContentBlock, ToolCall } from "@/lib/types"

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
