import type { ThinkingBlock, ToolCall, Turn } from "../../shared/session/types"
import { getUserMessageText } from "../../shared/session/parser"
import { stripSystemTags } from "@/lib/userMessageContent"

/** Where a piece of a turn's text renders, so find can reveal and scope it. */
export type FindPart =
  | { kind: "prompt" }
  | { kind: "compaction" }
  /** Text, a queued prompt, an agent message, a plan or a recap: `contentBlocks[block]`. */
  | { kind: "block"; block: number }
  | { kind: "thinking"; block: number; blocks: readonly ThinkingBlock[] }
  | { kind: "tool"; block: number; callId: string }

export interface FindSegment {
  part: FindPart
  text: string
}

interface TurnIndex {
  segments: FindSegment[]
  lower: string[] | null
}

/** One occurrence of the query: in `turns[turn]`, inside its `segment`. */
export interface FindHit {
  turn: number
  segment: number
}

const indexes = new WeakMap<Turn, TurnIndex>()

/**
 * Lower-cases without changing the length, so an offset found in the folded
 * text is the same offset in the original (the DOM recount relies on it).
 */
export function foldCase(text: string): string {
  const lower = text.toLowerCase()
  if (lower.length === text.length) return lower
  let out = ""
  for (const char of text) {
    const folded = char.toLowerCase()
    out += folded.length === char.length ? folded : char
  }
  return out
}

/** Non-overlapping occurrences of `query` (already folded) in `text` (already folded). */
export function occurrencesIn(text: string, query: string): number[] {
  const found: number[] = []
  if (!query) return found
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) found.push(at)
  return found
}

function stringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value) out.push(value)
  } else if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value))
  } else if (Array.isArray(value)) {
    for (const item of value) stringValues(item, out)
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) stringValues(item, out)
  }
}

function toolText(call: ToolCall): string {
  const parts: string[] = []
  stringValues(call.input, parts)
  if (call.result) parts.push(call.result)
  return parts.join("\n")
}

function segmentsOf(turn: Turn): FindSegment[] {
  const segments: FindSegment[] = []
  const push = (part: FindPart, text: string | null | undefined) => {
    if (text) segments.push({ part, text })
  }
  push({ kind: "compaction" }, turn.compactionSummary)
  if (turn.userMessage) push({ kind: "prompt" }, stripSystemTags(getUserMessageText(turn.userMessage)))
  turn.contentBlocks.forEach((block, index) => {
    switch (block.kind) {
      case "text":
        push({ kind: "block", block: index }, block.text.join("\n"))
        break
      case "thinking":
        push({ kind: "thinking", block: index, blocks: block.blocks }, block.blocks.map((b) => b.thinking).join("\n"))
        break
      case "tool_calls":
        for (const call of block.toolCalls) push({ kind: "tool", block: index, callId: call.id }, toolText(call))
        break
      case "queued_prompt":
      case "recap":
        push({ kind: "block", block: index }, block.content)
        break
      case "agent_message":
        push({ kind: "block", block: index }, `${block.sender}\n${block.body}`)
        break
      case "plan_mode":
        push({ kind: "block", block: index }, block.plan)
        break
    }
  })
  return segments
}

function indexOf(turn: Turn): TurnIndex {
  let index = indexes.get(turn)
  if (!index) indexes.set(turn, index = { segments: segmentsOf(turn), lower: null })
  return index
}

/**
 * The text of a turn as the timeline shows it: prompt, replies, thinking, tool
 * inputs and results, in render order. Cached per Turn object, so a turn that
 * keeps its identity across live updates is indexed once.
 */
export function turnSegments(turn: Turn): readonly FindSegment[] {
  return indexOf(turn).segments
}

function lowerSegments(turn: Turn): string[] {
  const index = indexOf(turn)
  return index.lower ??= index.segments.map((segment) => foldCase(segment.text))
}

export function turnMatches(turn: Turn, query: string): boolean {
  const q = foldCase(query)
  return q.length > 0 && lowerSegments(turn).some((text) => text.includes(q))
}

/** Every occurrence of `query` in `turns`, in timeline order, whether or not its row is mounted. */
export function findInTurns(turns: readonly Turn[], query: string): FindHit[] {
  const q = foldCase(query)
  const hits: FindHit[] = []
  if (!q) return hits
  turns.forEach((turn, t) => {
    lowerSegments(turn).forEach((text, segment) => {
      const count = occurrencesIn(text, q).length
      for (let i = 0; i < count; i++) hits.push({ turn: t, segment })
    })
  })
  return hits
}
