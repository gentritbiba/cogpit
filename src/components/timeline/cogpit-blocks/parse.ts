import { load } from "js-yaml"
import type { CogpitBlockKind } from "./kinds"

/**
 * The three blocks, read from the YAML (or JSON) an agent wrote. Lenient on
 * shape, strict on meaning: anything it cannot read as the block it claims
 * to be is null, and the code shows as written.
 */

export type StatusTone = "warning" | "danger" | "success"

export interface StatusBlock {
  kind: "status"
  title?: string
  progress?: { done: number; total: number }
  values: Array<{ label: string; value: string; tone?: StatusTone }>
}

export interface Decision {
  id: string
  question: string
  options: string[]
  recommended?: string
  detail?: string
}

export interface DecisionsBlock {
  kind: "decisions"
  title?: string
  decisions: Decision[]
}

export type ChecklistState = "todo" | "doing" | "done" | "blocked" | "skipped"

export interface ChecklistBlock {
  kind: "checklist"
  title?: string
  items: Array<{ text: string; state: ChecklistState; note?: string }>
}

export type CogpitBlock = StatusBlock | DecisionsBlock | ChecklistBlock

type Record_ = Record<string, unknown>

const isRecord = (value: unknown): value is Record_ => typeof value === "object" && value !== null && !Array.isArray(value)

/** A scalar as text; null for anything else. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return null
}

function count(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : null
}

/** The list a block holds: the document itself, or the first list under one of `keys`. */
function listIn(document: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(document)) return document
  if (!isRecord(document)) return null
  for (const key of keys) if (Array.isArray(document[key])) return document[key] as unknown[]
  return null
}

function titleOf(document: unknown): { title?: string } {
  const title = isRecord(document) ? text(document.title) : null
  return title ? { title } : {}
}

const TONES = new Set<StatusTone>(["warning", "danger", "success"])

function status(document: unknown): StatusBlock | null {
  if (!isRecord(document)) return null
  const progress = isRecord(document.progress) ? document.progress : null
  const done = count(progress?.done)
  const total = count(progress?.total)
  const values = (Array.isArray(document.values) ? document.values : []).flatMap((entry) => {
    if (!isRecord(entry)) return []
    const label = text(entry.label)
    const value = text(entry.value)
    if (!label || value === null) return []
    const tone = text(entry.tone) as StatusTone | null
    return [{ label, value, ...(tone && TONES.has(tone) && { tone }) }]
  })
  const block: StatusBlock = {
    kind: "status",
    ...titleOf(document),
    ...(done !== null && total !== null && total > 0 && { progress: { done: Math.min(done, total), total } }),
    values,
  }
  return block.progress || values.length > 0 ? block : null
}

function decisions(document: unknown): DecisionsBlock | null {
  const list = listIn(document, ["decisions", "items"])
  if (!list) return null
  const parsed = list.flatMap((entry, index): Decision[] => {
    if (!isRecord(entry)) return []
    const question = text(entry.question)
    const options = (Array.isArray(entry.options) ? entry.options : []).map(text).filter((option): option is string => Boolean(option))
    if (!question || options.length === 0) return []
    const recommended = text(entry.recommended)
    const detail = text(entry.detail)
    return [{
      id: text(entry.id) ?? String(index + 1),
      question,
      options,
      ...(recommended && options.includes(recommended) && { recommended }),
      ...(detail && { detail }),
    }]
  })
  if (new Set(parsed.map((decision) => decision.id)).size !== parsed.length) return null
  return parsed.length > 0 ? { kind: "decisions", ...titleOf(document), decisions: parsed } : null
}

const STATES = new Set<ChecklistState>(["todo", "doing", "done", "blocked", "skipped"])

function checklist(document: unknown): ChecklistBlock | null {
  const list = listIn(document, ["items"])
  if (!list) return null
  const items = list.flatMap((entry) => {
    const bare = text(entry)
    if (bare) return [{ text: bare, state: "todo" as const }]
    if (!isRecord(entry)) return []
    const itemText = text(entry.text)
    if (!itemText) return []
    const state = text(entry.state) as ChecklistState | null
    const note = text(entry.note)
    return [{ text: itemText, state: state && STATES.has(state) ? state : "todo" as const, ...(note && { note }) }]
  })
  return items.length > 0 ? { kind: "checklist", ...titleOf(document), items } : null
}

const READERS: Record<CogpitBlockKind, (document: unknown) => CogpitBlock | null> = { status, decisions, checklist }

export function parseCogpitBlock(kind: CogpitBlockKind, source: string): CogpitBlock | null {
  let document: unknown
  try {
    document = load(source)
  } catch {
    return null
  }
  return READERS[kind](document)
}

/** The answers given, as the one message that goes back: "Decisions:" then a line each, in the block's order. */
export function decisionsMessage(decisions: readonly Decision[], answers: Readonly<Record<string, string>>): string {
  const lines = decisions
    .filter((decision) => answers[decision.id])
    .map((decision) => `- ${decision.id}: ${decision.question} ${answers[decision.id]}`)
  return ["Decisions:", ...lines].join("\n")
}
