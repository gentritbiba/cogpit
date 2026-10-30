// SHARED SESSION CORE: edit shared/session only; cogpit-memory copies are generated.
/**
 * Result projection v1: how a heavy tool result travels without its body.
 *
 * A transcript line keeps its native shape; each tool-result string over the
 * threshold is replaced in place by an elided body — a marker, a small stub
 * naming an opaque reference and the original size, and a head-and-tail
 * preview. Every format parser then reads the line exactly as before, so turn
 * structure, ids, statuses and error flags come out the same; only the body
 * stays on the server until a reader asks for it by reference.
 *
 * Formats name where their results live (`AgentFormat.projectResults`) and
 * visit candidates in a fixed order, so the same walk finds field `n` again
 * when the server serves its body.
 */

import type { ElidedResult, ParsedSession, ToolCall } from "./types"

/** Opens an elided body. Never produced by a CLI; U+2063 is an invisible separator. */
export const ELIDED_MARK = "\u2063cogpit-elided-v1:"
const STUB_END = "\u2063"

export type { ElidedResult }

/** Bodies smaller than this travel whole. */
export const ELISION_THRESHOLD_BYTES = 16 * 1024
const PREVIEW_HEAD_CHARS = 2000
const PREVIEW_TAIL_CHARS = 1000

export function elidedText(stub: ElidedResult, preview: string): string {
  return `${ELIDED_MARK}${JSON.stringify(stub)}${STUB_END}${preview}`
}

/** The stub and preview of an elided body, or null for an ordinary one. */
export function readElided(text: string | null | undefined): { stub: ElidedResult; preview: string } | null {
  if (!text || !text.startsWith(ELIDED_MARK)) return null
  const end = text.indexOf(STUB_END, ELIDED_MARK.length)
  if (end < 0) return null
  try {
    const stub = JSON.parse(text.slice(ELIDED_MARK.length, end)) as ElidedResult
    if (typeof stub.ref !== "string" || typeof stub.bytes !== "number") return null
    return { stub, preview: text.slice(end + STUB_END.length) }
  } catch {
    return null
  }
}

/** The readable part of a result: its preview when elided, else itself. */
export function resultPreviewText(text: string): string {
  return readElided(text)?.preview ?? text
}

/** The head and tail of a body, where exit codes and status lines live. */
export function previewOf(text: string): string {
  if (text.length <= PREVIEW_HEAD_CHARS + PREVIEW_TAIL_CHARS) return text
  return `${text.slice(0, PREVIEW_HEAD_CHARS)}\n…\n${text.slice(-PREVIEW_TAIL_CHARS)}`
}

export function countLines(text: string): number {
  let lines = 1
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) lines++
  return lines
}

/** Called once per candidate body, in a fixed order; returns what the line should carry. */
export type ResultVisitor = (value: string, kind: ElidedResult["kind"]) => string

/** Walks a record's result candidates and writes back what the visitor returns; true when anything changed. */
export type ResultProjector = (record: Record<string, unknown>, visit: ResultVisitor) => boolean

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Visits `holder[key]` when it is a string, writing back a replacement; true when it changed. */
export function visitField(holder: Record<string, unknown>, key: string, visit: ResultVisitor, kind: ElidedResult["kind"] = "text"): boolean {
  const value = holder[key]
  if (typeof value !== "string") return false
  const next = visit(value, kind)
  if (next === value) return false
  holder[key] = next
  return true
}

/**
 * Visits the text parts of a multi-part result as the one body its reader
 * joins them into (with `separator`, skipping parts `textOf` finds none in),
 * so expanding it restores every part. When replaced, the first text part
 * carries the elided body and the other text parts go; every other part
 * keeps its place. Null when nothing changed.
 */
export function visitJoinedText(
  parts: readonly unknown[],
  textOf: (part: unknown) => string | undefined,
  separator: string,
  withText: (part: unknown, text: string) => unknown,
  visit: ResultVisitor,
): unknown[] | null {
  const texts = parts.map(textOf)
  const first = texts.findIndex((text) => text !== undefined)
  if (first < 0) return null
  const joined = texts.filter((text): text is string => Boolean(text)).join(separator)
  const replacement = visit(joined, "text")
  if (replacement === joined) return null
  return parts.flatMap((part, index) => index === first ? [withText(part, replacement)] : texts[index] === undefined ? [part] : [])
}

function liftCalls(calls: readonly ToolCall[]): void {
  for (const call of calls) {
    const elided = readElided(call.result)
    if (!elided) continue
    call.result = elided.preview
    call.resultRef = elided.stub
  }
}

/**
 * Moves each elided result body's stub onto its call as `resultRef`, leaving
 * the preview as `result`, so every reader of a result reads text. In place,
 * and idempotent: a lifted call carries no marker.
 */
export function liftElidedResults(session: ParsedSession): ParsedSession {
  for (const turn of session.turns) {
    liftCalls(turn.toolCalls)
    for (const message of turn.subAgentActivity) liftCalls(message.toolCalls)
    for (const block of turn.contentBlocks) {
      if (block.kind === "tool_calls" || block.kind === "plan_mode") liftCalls(block.toolCalls)
      else if (block.kind === "sub_agent" || block.kind === "background_agent") for (const message of block.messages) liftCalls(message.toolCalls)
    }
  }
  return session
}
