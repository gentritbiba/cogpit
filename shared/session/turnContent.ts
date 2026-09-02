import type { Turn } from "./types"

export function appendAssistantText(turn: Turn, text: string, timestamp: string): void {
  if (!text) return
  turn.assistantText.push(text)
  const last = turn.contentBlocks[turn.contentBlocks.length - 1]
  if (last?.kind === "text") {
    last.text.push(text)
    return
  }
  turn.contentBlocks.push({ kind: "text", text: [text], timestamp })
}
