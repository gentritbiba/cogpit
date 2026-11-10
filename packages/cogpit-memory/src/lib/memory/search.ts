// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
import type { AgentKind } from "../types"
import { collapseDuplicates, rrfScore } from "./fusion"
import { countTermMatches, ftsQuery, keywordCounts, keywordSearch, type ChunkRow, type ProseFilters } from "./keywordSearch"
import type { MemoryStore } from "./store"
import type { ChunkKind, MemoryHit, SemanticStatus } from "./types"

export interface ProseSearchOptions extends ProseFilters {
  /** Hits returned, 1-200. Default 20. */
  limit?: number
  /** True when the transcript at `path` exists; a hit whose file is gone is `archived`. */
  fileExists?: (path: string) => boolean
}

export interface ProseSearchResult {
  /** Fused, duplicate-collapsed, best first. */
  hits: MemoryHit[]
  /** Chunks matching the keywords, before the limit. */
  keywordHits: number
  /** Sessions with at least one keyword match. */
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

/** Ranked prose hits for `query`. Never throws for lack of embeddings. */
export async function searchProse(store: MemoryStore, query: string, options: ProseSearchOptions = {}): Promise<ProseSearchResult> {
  const limit = clampSearchLimit(options.limit)
  const semantic: SemanticStatus = { state: "unavailable", reason: "no embedding endpoint is configured" }
  const fts = ftsQuery(query)
  if (!fts) return { hits: [], keywordHits: 0, sessionsMatched: 0, semantic }

  const rows = keywordSearch(store, fts, options, limit * CANDIDATES_PER_HIT)
  const counts = rows.length < limit * CANDIDATES_PER_HIT
    ? { hits: rows.length, sessions: new Set(rows.map((row) => row.session_id)).size }
    : keywordCounts(store, fts, options)
  const archived = archiveCheck(options.fileExists)
  const ranked = collapseDuplicates(rows.map((row) => toHit(row, countTermMatches(row.text, fts.terms), archived)), (hit) => hit.textHash)
  const hits = ranked.slice(0, limit).map((hit, index) => {
    hit.ranks = { keyword: index + 1 }
    hit.score = rrfScore([hit.ranks.keyword])
    return hit
  })
  return { hits, keywordHits: counts.hits, sessionsMatched: counts.sessions, semantic }
}

export function chunkLocation(row: Pick<ChunkRow, "turn" | "kind" | "agent_id" | "inline_agent_id">): string {
  const field = LOCATION_FIELDS[row.kind]
  if (row.agent_id) return `agent/${row.agent_id}/turn/${row.turn}/${field}`
  if (row.inline_agent_id) return `agent/${row.inline_agent_id}/${field}`
  return `turn/${row.turn}/${field}`
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

function toHit(row: ChunkRow, matchCount: number, isArchived: (path: string) => boolean): MemoryHit {
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
    snippet: row.snippet,
    text: row.text,
    textHash: row.text_hash,
    timestamp: row.timestamp,
    automated: row.automated === 1,
    matchCount: Math.max(1, matchCount),
    match: "keyword",
    score: 0,
    ranks: {},
    archived: isArchived(row.source_file),
    duplicates: 0,
  }
}
