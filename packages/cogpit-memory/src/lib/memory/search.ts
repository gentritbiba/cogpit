// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
import type { AgentKind } from "../types"
import { DEFAULT_MIN_SCORE, type EmbeddingClient, type QuantizedVector } from "./embeddings"
import { collapseDuplicates, rrfScore } from "./fusion"
import { chunkRows, countTermMatches, ftsQuery, keywordCounts, keywordSearch, unmatchedCounts, type ChunkFilters, type ChunkRow, type ProseFilters } from "./keywordSearch"
import type { MemoryStore } from "./store"
import type { ChunkKind, MemoryHit, SemanticStatus } from "./types"
import { vectorSearch, type VectorMatch } from "./vectors"

export type SearchMode = "hybrid" | "keyword" | "semantic"
export const SEARCH_MODES: readonly SearchMode[] = ["hybrid", "keyword", "semantic"]

export interface ProseSearchOptions extends ProseFilters {
  /** Hits returned, 1-200. Default 20. */
  limit?: number
  /** True when the transcript at `path` exists; a hit whose file is gone is `archived`, and a live copy of the same text is kept over it. */
  fileExists?: (path: string) => boolean
  /** With `fileExists`, leave out text whose transcript is gone before fusion, duplicate folding and the limit. */
  liveOnly?: boolean
  /** Default hybrid: keywords and meaning, fused. */
  mode?: SearchMode
  /** Without a client, search is keyword-only and `semantic` says why. */
  embeddings?: EmbeddingClient | null
}

export interface ProseSearchResult {
  /** Fused, duplicate-collapsed, best first. */
  hits: MemoryHit[]
  /** Chunks matching the keywords, before the limit. */
  keywordHits: number
  /** Chunks reaching `minScore` that the keywords do not match. */
  semanticHits: number
  /** Sessions with at least one keyword or semantic match. */
  sessionsMatched: number
  semantic: SemanticStatus
}

export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 200

/** Each list contributes this many candidates per requested hit before fusion and collapsing. */
const CANDIDATES_PER_HIT = 3

const LOCATION_FIELDS: Record<ChunkKind, string> = {
  user: "userMessage",
  assistant: "assistantMessage",
  thinking: "thinking",
  compaction: "compactionSummary",
  recap: "recap",
  plan: "plan",
  agent_message: "agentMessage",
}

export function clampSearchLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_SEARCH_LIMIT)), MAX_SEARCH_LIMIT)
}

interface Candidate {
  row?: ChunkRow
  keyword?: number
  semantic?: number
  similarity?: number
}

/**
 * Ranked prose hits for `query`: BM25 over the chunk text and, when an
 * embedding client is given, cosine similarity over stored vectors, fused by
 * reciprocal rank. Never throws for lack of embeddings: a missing or failing
 * endpoint leaves keyword results and says why in `semantic`.
 */
export async function searchProse(store: MemoryStore, query: string, options: ProseSearchOptions = {}): Promise<ProseSearchResult> {
  const limit = clampSearchLimit(options.limit)
  const depth = limit * CANDIDATES_PER_HIT
  const mode = options.mode ?? "hybrid"
  const client = mode === "keyword" ? null : options.embeddings ?? null
  const queryVector = client ? embedQuerySafely(client, query) : null
  const fts = ftsQuery(query)
  const archived = archiveCheck(options.fileExists)
  const filters: ChunkFilters = options.liveOnly && options.fileExists ? { ...options, excludeFileIds: archivedFileIds(store, archived) } : options

  let rows = fts && mode !== "semantic" ? keywordSearch(store, fts, filters, depth) : []
  let semantic: SemanticStatus = mode === "keyword" ? { state: "off" } : { state: "unavailable", reason: "no embedding endpoint is configured" }
  let matches: VectorMatch[] = []
  let aboveFloor: number[] = []
  if (client && queryVector) {
    const embedded = await queryVector
    if ("vector" in embedded) {
      semantic = { state: "ready" }
      const found = vectorSearch(store, embedded.vector, client.fingerprint, filters, depth, client.config.minScore ?? DEFAULT_MIN_SCORE)
      matches = found.matches
      aboveFloor = found.aboveFloor
    } else {
      semantic = { state: "unavailable", reason: embedded.error }
    }
  }
  // Asked for meaning only and none is available: keywords still answer.
  if (mode === "semantic" && semantic.state !== "ready" && fts) rows = keywordSearch(store, fts, filters, depth)

  const candidates = new Map<number, Candidate>()
  rows.forEach((row, index) => candidates.set(row.id, { row, keyword: index + 1 }))
  matches.forEach((match, index) => {
    const candidate = candidates.get(match.chunkId) ?? {}
    candidates.set(match.chunkId, { ...candidate, semantic: index + 1, similarity: match.similarity })
  })
  const missing = [...candidates].filter(([, candidate]) => !candidate.row).map(([id]) => id)
  for (const row of chunkRows(store, missing)) candidates.get(row.id)!.row = row

  const terms = fts?.terms ?? []
  const fused = [...candidates.values()]
    .filter((candidate): candidate is Candidate & { row: ChunkRow } => !!candidate.row)
    .map((candidate) => toHit(candidate, terms, archived))
    .sort((a, b) => b.score - a.score || Math.min(a.ranks.keyword ?? Infinity, a.ranks.semantic ?? Infinity) - Math.min(b.ranks.keyword ?? Infinity, b.ranks.semantic ?? Infinity))
  const hits = collapseDuplicates(fused, (hit) => hit.textHash, (hit) => !hit.archived).slice(0, limit)

  const counts = !fts || rows.length < depth
    ? { hits: rows.length, sessions: new Set(rows.map((row) => row.session_id)).size }
    : keywordCounts(store, fts, filters)
  const keywordsSearched = mode !== "semantic" || semantic.state !== "ready"
  const semanticOnly = unmatchedCounts(store, aboveFloor, keywordsSearched ? fts : null, filters)
  return { hits, keywordHits: counts.hits, semanticHits: semanticOnly.hits, sessionsMatched: counts.sessions + semanticOnly.sessions, semantic }
}

async function embedQuerySafely(client: EmbeddingClient, query: string): Promise<{ vector: QuantizedVector } | { error: string }> {
  try {
    return { vector: await client.embedQuery(query) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const SNIPPET_CHARS = 240

/** A semantic-only hit's snippet: centred on the first query word it shares, else its opening. */
export function semanticSnippet(text: string, terms: readonly string[]): string {
  if (text.length <= SNIPPET_CHARS) return text
  const lower = text.toLowerCase()
  const at = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, Math.min(at - SNIPPET_CHARS / 2, text.length - SNIPPET_CHARS))
  const end = start + SNIPPET_CHARS
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`
}

export function chunkLocation(row: Pick<ChunkRow, "turn" | "kind" | "agent_id" | "inline_agent_id">): string {
  const field = LOCATION_FIELDS[row.kind]
  if (row.agent_id) return `agent/${row.agent_id}/turn/${row.turn}/${field}`
  if (row.inline_agent_id) return `agent/${row.inline_agent_id}/${field}`
  return `turn/${row.turn}/${field}`
}

function archivedFileIds(store: MemoryStore, isArchived: (path: string) => boolean): number[] {
  const files = store.db.prepare("SELECT id, path FROM source_files").all() as Array<{ id: number; path: string }>
  return files.filter((file) => isArchived(file.path)).map((file) => file.id)
}

function archiveCheck(fileExists: ((path: string) => boolean) | undefined): (path: string) => boolean {
  if (!fileExists) return () => false
  const known = new Map<string, boolean>()
  return (path) => {
    let gone = known.get(path)
    if (gone === undefined) known.set(path, gone = !fileExists(path))
    return gone
  }
}

function toHit(candidate: Candidate & { row: ChunkRow }, terms: readonly string[], isArchived: (path: string) => boolean): MemoryHit {
  const { row } = candidate
  const ranks = {
    ...(candidate.keyword !== undefined ? { keyword: candidate.keyword } : {}),
    ...(candidate.semantic !== undefined ? { semantic: candidate.semantic } : {}),
  }
  const keyword = candidate.keyword !== undefined
  return {
    chunkId: row.id,
    sessionId: row.session_id,
    instanceId: row.instance_id,
    agentKind: row.agent_kind as AgentKind,
    cwd: row.cwd,
    title: row.title,
    sourceFile: row.source_file,
    turn: row.turn,
    turnId: row.turn_id,
    agentId: row.agent_id,
    inlineAgentId: row.inline_agent_id,
    kind: row.kind,
    location: chunkLocation(row),
    snippet: keyword ? row.snippet : semanticSnippet(row.text, terms),
    text: row.text,
    textHash: row.text_hash,
    timestamp: row.timestamp,
    automated: row.automated === 1,
    matchCount: keyword ? Math.max(1, countTermMatches(row.text, terms)) : 0,
    match: keyword && candidate.semantic !== undefined ? "both" : keyword ? "keyword" : "semantic",
    score: rrfScore([candidate.keyword, candidate.semantic]),
    ranks,
    ...(candidate.similarity !== undefined ? { similarity: candidate.similarity } : {}),
    archived: isArchived(row.source_file),
    duplicates: 0,
  }
}
