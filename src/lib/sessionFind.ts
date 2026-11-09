import type { ThinkingBlock, ToolCall, Turn } from "../../shared/session/types"
import { getUserMessageText } from "../../shared/session/parser"
import { stripSystemTags } from "@/lib/userMessageContent"

/** Where a piece of a turn's text renders, so find can reveal and scope it. */
export type FindPart =
  | { kind: "prompt" }
  | { kind: "compaction" }
  /** Text, a queued prompt, an agent message, a plan, a recap or a notice: `contentBlocks[block]`. */
  | { kind: "block"; block: number }
  | { kind: "thinking"; block: number; blocks: readonly ThinkingBlock[] }
  /** A tool call's input values, or its result, which renders last in the card. */
  | { kind: "tool"; block: number; callId: string; result: boolean }

export interface FindSegment {
  part: FindPart
  text: string
}

/** Segments with occurrences of a query, in timeline order, and the running total before each. */
export interface FindResults {
  groups: { turn: number; segment: number; count: number }[]
  starts: number[]
  total: number
}

export const NO_RESULTS: FindResults = { groups: [], starts: [], total: 0 }

const segmentsByTurn = new WeakMap<Turn, FindSegment[]>()
const countsByTurn = new WeakMap<Turn, { query: string; counts: number[] }>()

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The case-insensitive pattern find matches with, in the model and in the DOM
 * alike. Matching with a regex keeps offsets in the original text and needs
 * no lower-cased copy of the session.
 */
export function queryPattern(query: string): RegExp | null {
  return query ? new RegExp(escapeRegExp(query), "gi") : null
}

/** Non-overlapping occurrences of `pattern` in `text`, as [start, end) offsets. */
export function occurrencesIn(text: string, pattern: RegExp): [number, number][] {
  const found: [number, number][] = []
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    found.push([match.index, match.index + match[0].length])
  }
  return found
}

function countIn(text: string, pattern: RegExp): number {
  let count = 0
  pattern.lastIndex = 0
  while (pattern.exec(text)) count++
  return count
}

const TAG = /<\/?[A-Za-z][\w-]*[^>]*>/g

function stringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value) out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) stringValues(item, out)
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) stringValues(item, out)
  }
}

function pushTool(segments: FindSegment[], block: number, call: ToolCall): void {
  const inputs: string[] = []
  stringValues(call.input, inputs)
  for (const text of inputs) segments.push({ part: { kind: "tool", block, callId: call.id, result: false }, text })
  if (call.result) segments.push({ part: { kind: "tool", block, callId: call.id, result: true }, text: call.result })
}

function segmentsOf(turn: Turn): FindSegment[] {
  const segments: FindSegment[] = []
  const push = (part: FindPart, text: string | null | undefined) => {
    if (text) segments.push({ part, text })
  }
  push({ kind: "compaction" }, turn.compactionSummary)
  if (turn.userMessage) push({ kind: "prompt" }, stripSystemTags(getUserMessageText(turn.userMessage)))
  turn.contentBlocks.forEach((block, index) => {
    const part: FindPart = { kind: "block", block: index }
    switch (block.kind) {
      case "text":
        for (const text of block.text) push(part, text)
        break
      case "thinking": {
        const thinking: FindPart = { kind: "thinking", block: index, blocks: block.blocks }
        for (const b of block.blocks) push(thinking, b.thinking)
        break
      }
      case "tool_calls":
        for (const call of block.toolCalls) pushTool(segments, index, call)
        break
      case "queued_prompt":
      case "recap":
        push(part, block.content)
        break
      case "task_notification":
      case "local_command":
        push(part, block.content.replace(TAG, " "))
        break
      case "agent_message":
        push(part, block.sender)
        push(part, block.body)
        push(part, block.reply?.summary)
        break
      case "plan_mode":
        push(part, block.plan)
        for (const call of block.toolCalls) pushTool(segments, index, call)
        break
    }
  })
  return segments
}

/**
 * The text of a turn as the timeline shows it: prompt, replies, thinking, tool
 * inputs and results, notices, in render order. Cached per Turn object; the
 * segments are mostly the turn's own strings, so the index costs little memory.
 */
export function turnSegments(turn: Turn): readonly FindSegment[] {
  let segments = segmentsByTurn.get(turn)
  if (!segments) segmentsByTurn.set(turn, segments = segmentsOf(turn))
  return segments
}

function countsOf(turn: Turn, query: string, pattern: RegExp): number[] {
  const cached = countsByTurn.get(turn)
  if (cached?.query === query) return cached.counts
  const counts = turnSegments(turn).map((segment) => countIn(segment.text, pattern))
  countsByTurn.set(turn, { query, counts })
  return counts
}

/** Whether a turn mentions `query` in its text or a tool's name (the session filter). */
export function turnMatches(turn: Turn, query: string): boolean {
  const pattern = queryPattern(query)
  if (!pattern) return false
  const lower = query.toLowerCase()
  return turn.toolCalls.some((call) => call.name.toLowerCase().includes(lower))
    || turnSegments(turn).some((segment) => {
      pattern.lastIndex = 0
      return pattern.test(segment.text)
    })
}

/**
 * Every occurrence of `query` in `turns`, in timeline order, mounted or not.
 * Counts are kept per turn and query, so a streamed record recounts only the
 * turns it changed, and one entry stands for all the hits in a segment.
 */
export function findInTurns(turns: readonly Turn[], query: string): FindResults {
  const pattern = queryPattern(query)
  if (!pattern) return NO_RESULTS
  const results: FindResults = { groups: [], starts: [], total: 0 }
  turns.forEach((turn, t) => {
    countsOf(turn, query, pattern).forEach((count, segment) => {
      if (count === 0) return
      results.groups.push({ turn: t, segment, count })
      results.starts.push(results.total)
      results.total += count
    })
  })
  return results
}

/** The group holding hit `index` (0 ≤ index < total). */
export function groupOfHit(results: FindResults, index: number): number {
  let lo = 0
  let hi = results.groups.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (results.starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The first group of `turn`, or -1. */
export function firstGroupOfTurn(results: FindResults, turn: number): number {
  let lo = 0
  let hi = results.groups.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (results.groups[mid].turn < turn) lo = mid + 1
    else hi = mid
  }
  return lo < results.groups.length && results.groups[lo].turn === turn ? lo : -1
}
