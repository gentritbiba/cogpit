// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
/**
 * Ranked keyword search over prose chunks: the query's words are ORed and
 * BM25 orders the chunks, so a question finds the passage that shares most of
 * its rarer words. A quoted part of the query stays an exact phrase.
 */
import { firstRow, type SqlValue } from "./database"
import type { MemoryStore } from "./store"
import type { ChunkKind } from "./types"

export interface ProseFilters {
  sessionId?: string
  /** Omit this session and its subagents. */
  excludeSessionId?: string
  /** Only this account instance; a provider worker passes its own. */
  instanceId?: string
  cwd?: string
  /** Only chunks written at or after this time (epoch ms). */
  sinceMs?: number
  /** Include prompts Cogpit or other agents wrote on someone's behalf. Default true. */
  includeAutomated?: boolean
}

export interface FtsQuery {
  match: string
  /** Lower-cased words and phrases, for counting matches in a chunk. */
  terms: string[]
}

/** A chunk row as search reads it, with the joined file path and session title. */
export interface ChunkRow {
  id: number
  session_id: string
  instance_id: string
  agent_kind: string
  cwd: string
  title: string | null
  source_file: string
  turn: number
  turn_id: string | null
  agent_id: string | null
  inline_agent_id: string | null
  kind: ChunkKind
  text: string
  text_hash: string
  timestamp: string | null
  automated: number
  snippet: string
}

const MAX_TERMS = 24
const SNIPPET_TOKENS = 40

/** Words too common to rank by; dropped unless the query has nothing else. */
const STOPWORDS = new Set(("a about above after again all am an and any are as at be because been before being below between both but by can " +
  "could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its " +
  "itself just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that " +
  "the their theirs them then there these they this those through to too under until up very was we were what when where which while who " +
  "whom why will with would you your yours").split(" "))

export function ftsQuery(query: string): FtsQuery | null {
  const phrases: string[] = []
  const rest = query.replace(/"([^"]+)"/g, (_, phrase: string) => {
    if (phrase.trim()) phrases.push(phrase.trim().toLowerCase())
    return " "
  })
  const words = [...new Set(rest.split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase())
    .filter(Boolean))]
  const meaningful = words.filter((word) => !STOPWORDS.has(word))
  const terms = [...phrases, ...(meaningful.length > 0 || phrases.length > 0 ? meaningful : words)].slice(0, MAX_TERMS)
  if (terms.length === 0) return null
  return { match: terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR "), terms }
}

/** Occurrences of the query's words and phrases in `text`, case-insensitive. */
export function countTermMatches(text: string, terms: readonly string[]): number {
  const haystack = text.toLowerCase()
  let count = 0
  for (const term of terms) {
    for (let at = haystack.indexOf(term); at !== -1; at = haystack.indexOf(term, at + term.length)) count++
  }
  return count
}

function filterSql(filters: ProseFilters): { sql: string; params: SqlValue[] } {
  const conditions: string[] = []
  const params: SqlValue[] = []
  const add = (condition: string, value: SqlValue) => {
    conditions.push(condition)
    params.push(value)
  }
  if (filters.sessionId) add("c.session_id = ?", filters.sessionId)
  if (filters.excludeSessionId) add("c.session_id != ?", filters.excludeSessionId)
  if (filters.instanceId) add("c.instance_id = ?", filters.instanceId)
  if (filters.cwd) add("c.cwd = ?", filters.cwd)
  if (filters.sinceMs !== undefined) add("c.ts_ms >= ?", filters.sinceMs)
  if (filters.includeAutomated === false) conditions.push("c.automated = 0")
  return { sql: conditions.map((condition) => ` AND ${condition}`).join(""), params }
}

const CHUNK_SELECT = `c.id, c.session_id, c.instance_id, c.agent_kind, c.cwd, s.title, f.path AS source_file, c.turn, c.turn_id,
  c.agent_id, c.inline_agent_id, c.kind, c.text, c.text_hash, c.timestamp, c.automated`

/** The best `limit` chunks for `query`, best first. */
export function keywordSearch(store: MemoryStore, query: FtsQuery, filters: ProseFilters, limit: number): ChunkRow[] {
  const where = filterSql(filters)
  return store.db.prepare(`
    SELECT ${CHUNK_SELECT}, snippet(chunks_fts, 0, '', '', '...', ${SNIPPET_TOKENS}) AS snippet
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN source_files f ON f.id = c.file_id
    LEFT JOIN sessions s ON s.session_id = c.session_id
    WHERE chunks_fts MATCH ?${where.sql}
    ORDER BY chunks_fts.rank
    LIMIT ?`).all(query.match, ...where.params, limit) as ChunkRow[]
}

export function keywordCounts(store: MemoryStore, query: FtsQuery, filters: ProseFilters): { hits: number; sessions: number } {
  const where = filterSql(filters)
  const row = firstRow<{ hits: number; sessions: number }>(store.db.prepare(`
    SELECT COUNT(*) AS hits, COUNT(DISTINCT c.session_id) AS sessions
    FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
    WHERE chunks_fts MATCH ?${where.sql}`), query.match, ...where.params)
  return { hits: row?.hits ?? 0, sessions: row?.sessions ?? 0 }
}
