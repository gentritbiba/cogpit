/**
 * One tab of the library for a scope: occurrences the caller may see, folded
 * so a link, view or file content shared again lists once (at its newest
 * mention), then filtered and cut into pages.
 */
import { statSync } from "node:fs"
import { libraryTabOf, type LibraryCounts, type LibraryItem, type LibraryResponse, type LibraryScope, type LibraryTab } from "../../shared/library/types"
import { projectOfCwd } from "../../shared/worktreePath"
import { CHANGED_AFTER_MS, keptFilePath } from "./keep"
import type { ItemRow, ItemScope, LibraryStore } from "./store"

/** Occurrences read per request; far more than anyone scrolls. */
const MAX_ROWS = 20_000

export interface LibraryQuery {
  scope: LibraryScope
  /** For the session scope. */
  sessionId?: string
  /** For the project scope; any folder of the project, worktrees included. */
  project?: string
  /** Without one, only the counts and view ids are answered. */
  tab?: LibraryTab
  /** Matched against the label and target, ignoring case. */
  text?: string
  /** The `next` of the page before. */
  before?: string
  limit: number
}

export interface ListOptions {
  filesDir: string
  /** Whether the caller may see what a session shared; asked once per session. */
  visible(sessionId: string, sourceFile: string): Promise<boolean>
}

/** The listing for `query`, without the index status the route adds. */
export async function listLibrary(store: LibraryStore, query: LibraryQuery, options: ListOptions): Promise<Omit<LibraryResponse, "available" | "pendingFiles">> {
  const rows = store.items(itemScope(query), MAX_ROWS)
  const fileAt = memoized(fileTime)
  const shown = new Map<string, Promise<boolean>>()
  const visibleRows: ItemRow[] = []
  for (const row of rows) {
    if ((row.kind === "image" || row.kind === "video") && !row.kept && !showsShared(row, fileAt(row.target))) continue
    const key = `${row.session_id}\u001f${row.source_file}`
    let visible = shown.get(key)
    if (!visible) shown.set(key, visible = options.visible(row.session_id, row.source_file))
    if (await visible) visibleRows.push(row)
  }

  const groups = new Map<string, { row: ItemRow; mentions: number }>()
  for (const row of visibleRows) {
    const key = groupKey(row)
    const group = groups.get(key)
    if (group) group.mentions++
    else groups.set(key, { row, mentions: 1 })
  }

  const counts: LibraryCounts = { media: 0, link: 0, file: 0 }
  const viewIds: string[] = []
  for (const { row } of groups.values()) {
    const tab = libraryTabOf(row.kind)
    if (tab) counts[tab]++
    else viewIds.push(row.target)
  }

  const text = query.text?.trim().toLowerCase()
  const cursor = parseCursor(query.before)
  const listed = !query.tab ? [] : [...groups.values()].filter(({ row }) => libraryTabOf(row.kind) === query.tab
    && (!text || row.target.toLowerCase().includes(text) || (row.label?.toLowerCase().includes(text) ?? false))
    && (!cursor || isBefore(row, cursor)))
  const page = listed.slice(0, query.limit)
  const last = page.at(-1)?.row
  const sessionIds = [...new Set(page.map(({ row }) => row.session_id))]
  return {
    counts,
    viewIds,
    items: page.map(({ row, mentions }) => toItem(row, mentions, options.filesDir, fileAt)),
    next: listed.length > page.length && last ? `${last.shared_ms ?? 0}:${last.id}` : null,
    sessions: Object.fromEntries(store.sessions(sessionIds).map((session) => [session.session_id, { title: session.title, cwd: session.cwd }])),
  }
}

function itemScope(query: LibraryQuery): ItemScope {
  if (query.scope === "session") return { sessionId: query.sessionId ?? "" }
  if (query.scope === "project") return { project: projectOfCwd(query.project ?? "") }
  return null
}

/** Links and views fold by target; files by content when a copy was kept, else by path. */
export function groupKey(row: Pick<ItemRow, "kind" | "target" | "kept">): string {
  const sameContent = row.kind !== "link" && row.kind !== "view" && row.kept
  return `${row.kind}\u001f${sameContent ? `#${row.kept}` : row.target}`
}

function parseCursor(before: string | undefined): { ms: number; id: number } | null {
  const match = before ? /^(-?\d+):(\d+)$/.exec(before) : null
  return match ? { ms: Number(match[1]), id: Number(match[2]) } : null
}

/** Rows come newest first by (shared time, id); a page starts after its cursor. */
function isBefore(row: ItemRow, cursor: { ms: number; id: number }): boolean {
  const ms = row.shared_ms ?? 0
  return ms < cursor.ms || (ms === cursor.ms && row.id < cursor.id)
}

/**
 * Without a copy, an image or video shows what its path holds now: only a
 * file written before the reply that shared it, give or take the same grace
 * the keep pass allows, is what the reply showed.
 */
function showsShared(row: ItemRow, mtimeMs: number | null): boolean {
  return mtimeMs !== null && (row.shared_ms === null || mtimeMs <= row.shared_ms + CHANGED_AFTER_MS)
}

function toItem(row: ItemRow, mentions: number, filesDir: string, fileAt: (path: string) => number | null): LibraryItem {
  return {
    id: row.id,
    kind: row.kind,
    target: row.target,
    label: row.label,
    sessionId: row.session_id,
    turnId: row.turn_id,
    turn: row.turn,
    sharedAt: row.shared_at,
    project: row.project,
    keptPath: row.kept && row.ext !== null ? keptFilePath(filesDir, row.kept, row.ext) : null,
    keepState: row.keep_state,
    present: row.kind === "link" || row.kind === "view" || fileAt(row.target) !== null,
    mentions,
  }
}

function memoized<T>(read: (path: string) => T): (path: string) => T {
  const known = new Map<string, T>()
  return (path) => {
    if (known.has(path)) return known.get(path) as T
    const value = read(path)
    known.set(path, value)
    return value
  }
}

/** When the regular file at `path` was last written; null when there is none. */
function fileTime(path: string): number | null {
  try {
    const info = statSync(path)
    return info.isFile() ? info.mtimeMs : null
  } catch {
    return null
  }
}
