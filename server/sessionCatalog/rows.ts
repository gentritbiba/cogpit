import type { SessionStatusInfo } from "../../shared/session/sessionStatus"
import type { SessionMeta } from "../agents/types"
import { getOrLoadSessionMeta } from "../lib/sessionMetaCache"
import { getSessionMeta, getSessionStatus } from "../sessionMetadata"
import { hasCatalogListeners, markCatalogChanged, subscribeTouchedFiles, type TouchedFile } from "./changes"
import { factsFor, isCurrent, recordFact } from "./facts"

/** What a list row shows of a session: its metadata and the status its tail gives. */
export interface CatalogRow {
  meta: SessionMeta
  status: SessionStatusInfo
}

/**
 * A session's row data at the size and mtime given: from memory or the saved
 * catalog when either was read at exactly that state, else read and kept.
 * Prompts are capped at 2000 characters, the same before and after a restart.
 */
export async function catalogRow(file: TouchedFile): Promise<CatalogRow> {
  const known = factsFor(file.filePath)?.row
  if (isCurrent(known, file)) return known!
  const { meta, status } = await getOrLoadSessionMeta(file.filePath, file.mtimeMs, async () => {
    const [meta, status] = await Promise.all([getSessionMeta(file.filePath), getSessionStatus(file.filePath)])
    return { meta, status }
  })
  return recordFact(file.filePath, "row", { meta, status, mtimeMs: file.mtimeMs, size: file.size })
}

/** The row data already known for exactly this size and mtime, without reading anything. */
export function peekCatalogRow(file: TouchedFile): CatalogRow | null {
  const known = factsFor(file.filePath)?.row
  return isCurrent(known, file) ? known! : null
}

/**
 * Fields whose change is worth announcing at once. `lastTimestamp` is left
 * out: it moves with every record a working agent writes, so it rides along
 * with the size and mtime as a touch.
 */
const ROW_FIELDS = [
  "slug", "name", "aiTitle", "customTitle", "model", "firstUserMessage", "lastUserMessage",
  "gitBranch", "cwd", "timestamp", "turnCount", "teamName", "agentName",
] as const satisfies ReadonlyArray<keyof SessionMeta>

function rowChanged(before: CatalogRow, after: CatalogRow): boolean {
  if (ROW_FIELDS.some((field) => before.meta[field] !== after.meta[field])) return true
  const a = before.status
  const b = after.status
  return a.status !== b.status || a.toolName !== b.toolName || a.terminalReason !== b.terminalReason
    || a.pendingAgents !== b.pendingAgents
}

/** A written file is re-read at most this often, and never more than a tenth of the time. */
const MIN_RECHECK_MS = 1_000
const RECHECK_COST_FACTOR = 10

const pending = new Map<string, TouchedFile>()
const nextCheckAt = new Map<string, number>()
let timer: ReturnType<typeof setTimeout> | null = null
let checking = false

function schedule(): void {
  if (timer || checking || pending.size === 0) return
  const now = Date.now()
  let earliest = Infinity
  for (const filePath of pending.keys()) earliest = Math.min(earliest, nextCheckAt.get(filePath) ?? now)
  timer = setTimeout(() => {
    timer = null
    void recheck()
  }, Math.max(0, earliest - now))
  timer.unref?.()
}

/**
 * Re-read the rows of written sessions to tell a visible change (status,
 * title, prompts) from a write that only grew the file. A session with no row
 * read yet is new to every list, so its write counts as visible unread.
 */
async function recheck(): Promise<void> {
  checking = true
  let visible = false
  try {
    const now = Date.now()
    for (const [filePath, file] of [...pending]) {
      if ((nextCheckAt.get(filePath) ?? 0) > now) continue
      pending.delete(filePath)
      const before = factsFor(filePath)?.row
      if (!before) {
        visible = true
        continue
      }
      const started = Date.now()
      try {
        if (rowChanged(before, await catalogRow(file))) visible = true
      } catch {
        visible = true
      }
      const finished = Date.now()
      nextCheckAt.set(filePath, finished + Math.max(MIN_RECHECK_MS, (finished - started) * RECHECK_COST_FACTOR))
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    checking = false
    if (visible) markCatalogChanged("visible")
    if (nextCheckAt.size > 1_000) {
      const now = Date.now()
      for (const [filePath, at] of nextCheckAt) if (at < now) nextCheckAt.delete(filePath)
    }
    schedule()
  }
}

let unsubscribe: (() => void) | null = null

/** Classify writes into visible and touch changes while anyone listens for them. */
export function startRowRechecks(): void {
  unsubscribe ??= subscribeTouchedFiles((files) => {
    if (!hasCatalogListeners()) return
    for (const file of files) pending.set(file.filePath, file)
    schedule()
  })
}

/** Test helper. */
export function stopRowRechecks(): void {
  unsubscribe?.()
  unsubscribe = null
  pending.clear()
  nextCheckAt.clear()
  if (timer) clearTimeout(timer)
  timer = null
}
