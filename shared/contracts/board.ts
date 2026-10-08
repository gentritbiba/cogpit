/**
 * A session's board: the one summary of a long piece of work that is always
 * current, kept by the agent doing it (`cogpit-session board set`) and shown
 * pinned above the composer of every session in its crew.
 */

export interface BoardSection {
  title: string
  /** `warning` for what needs the user, `success` for what landed. */
  tone?: "warning" | "success"
  items: string[]
}

export interface SessionBoard {
  sessionId: string
  title?: string
  progress?: { done: number; total: number }
  sections: BoardSection[]
  updatedAt: number
}

/** What a board may say, read from the document an agent sent; null when it says nothing. */
export type BoardContent = Omit<SessionBoard, "sessionId" | "updatedAt">

const MAX_SECTIONS = 6
const MAX_ITEMS = 12
const MAX_TEXT = 160

type Fields = Record<string, unknown>

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function line(value: unknown): string | null {
  const raw = typeof value === "string" ? value : typeof value === "number" ? String(value) : null
  const trimmed = raw?.replace(/\s+/g, " ").trim()
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null
}

function whole(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value
  return typeof number === "number" && Number.isInteger(number) && number >= 0 ? number : null
}

/** "35/99" or { done: 35, total: 99 }. */
export function parseBoardProgress(value: unknown): BoardContent["progress"] | null {
  if (typeof value === "string") {
    const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value)
    return match ? parseBoardProgress({ done: match[1], total: match[2] }) : null
  }
  if (!isFields(value)) return null
  const done = whole(value.done)
  const total = whole(value.total)
  return done !== null && total !== null && total > 0 ? { done: Math.min(done, total), total } : null
}

export function parseBoardContent(document: unknown): BoardContent | null {
  if (!isFields(document)) return null
  const title = line(document.title)
  const progress = parseBoardProgress(document.progress)
  const sections = (Array.isArray(document.sections) ? document.sections : []).slice(0, MAX_SECTIONS).flatMap((entry): BoardSection[] => {
    if (!isFields(entry)) return []
    const sectionTitle = line(entry.title)
    const items = (Array.isArray(entry.items) ? entry.items : []).map(line).filter((item): item is string => Boolean(item)).slice(0, MAX_ITEMS)
    if (!sectionTitle) return []
    const tone = entry.tone === "warning" || entry.tone === "success" ? entry.tone : undefined
    return [{ title: sectionTitle, ...(tone && { tone }), items }]
  })
  if (!title && !progress && sections.length === 0) return null
  return { ...(title && { title }), ...(progress && { progress }), sections }
}
