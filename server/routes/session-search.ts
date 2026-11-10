import type { IncomingMessage, ServerResponse } from "node:http"
import { searchProse, type SearchMode } from "../../shared/memory/search"
import type { ChunkKind, MatchKind, MemoryHit, SemanticStatus } from "../../shared/memory/types"
import { allStores, storeForPath } from "../agents"
import { lineageFromMeta } from "../agents/lineage"
import { mayActHostWide, visibilityFor, type VisibilityCheck } from "../edition"
import { sendJson, type UseFn } from "../http"
import { memoryIndexer } from "../memory"
import type { IndexingCounts } from "../memory/indexer"
import { transcriptExists } from "../memory/store"
import { sessionFileFor } from "../sessionCatalog"
import { requestScope } from "./requestScope"

/**
 * GET /api/session-search — ranked hits from the memory store's session text,
 * grouped by the session the UI opens, as far as the caller may see them.
 * The contract is frozen in the semantic-search plan (ROUTE-CONTRACT.md).
 */

export interface SessionSearchHit {
  chunkId: number
  kind: ChunkKind
  snippet: string
  timestamp: string | null
  match: MatchKind
  score: number
  automated: boolean
  agentId: string | null
  openTurnId: string | null
  openTurn: number | null
  text?: string
}

export interface SessionSearchResult {
  sessionId: string
  dirName: string | null
  fileName: string | null
  title: string | null
  cwd: string
  agentKind: string
  archived: boolean
  hits: SessionSearchHit[]
}

export interface SessionSearchResponse {
  query: string
  semantic: SemanticStatus
  indexing: IndexingCounts
  results: SessionSearchResult[]
}

interface SearchRequest {
  query: string
  limit: number
  cwd?: string
  mode: SearchMode
}

const MIN_QUERY_CHARS = 2
const DEFAULT_SESSIONS = 12
const MAX_SESSIONS = 50
const HITS_PER_SESSION = 3
/** Hits read per session asked for, so visibility and grouping still leave enough sessions. */
const HITS_PER_SESSION_ASKED = 8
const MAX_HITS = 200
const MODES: readonly SearchMode[] = ["hybrid", "keyword", "semantic"]

function readSearchRequest(params: URLSearchParams): SearchRequest | string {
  const query = params.get("q")?.trim() ?? ""
  if (query.length < MIN_QUERY_CHARS) return `q must be at least ${MIN_QUERY_CHARS} characters`
  const limitParam = params.get("limit")
  const limit = limitParam === null ? DEFAULT_SESSIONS : Number(limitParam)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SESSIONS) return `limit must be a whole number from 1 to ${MAX_SESSIONS}`
  const mode = params.get("mode") ?? "hybrid"
  if (!MODES.includes(mode as SearchMode)) return `mode must be one of ${MODES.join(", ")}`
  const cwd = params.get("cwd") || undefined
  return { query, limit, mode: mode as SearchMode, ...(cwd ? { cwd } : {}) }
}

/** The transcript the UI opens for a hit's session; a sub-agent's hit opens its parent. */
async function sessionTranscript(hit: MemoryHit): Promise<string | null> {
  if (!hit.agentId) return hit.sourceFile
  const known = sessionFileFor(hit.sessionId)
  if (known) return known
  const store = allStores().find((candidate) => candidate.kind === hit.agentKind && (candidate.instanceId ?? "default") === hit.instanceId)
  return (await store?.findSessionFile(hit.sessionId).catch(() => null)) ?? null
}

function toHit(hit: MemoryHit): SessionSearchHit {
  return {
    chunkId: hit.chunkId,
    kind: hit.kind,
    snippet: hit.snippet,
    timestamp: hit.timestamp,
    match: hit.match,
    score: hit.score,
    automated: hit.automated,
    agentId: hit.agentId,
    // A sub-agent's own transcript numbers its turns apart from the parent the UI opens.
    openTurnId: hit.agentId ? null : hit.turnId,
    openTurn: hit.agentId ? null : hit.turn,
    ...(hit.archived ? { text: hit.text } : {}),
  }
}

/** Hits grouped by session in rank order, each session as the caller may see it; archived ones only for an admin. */
async function groupVisible(hits: readonly MemoryHit[], limit: number, check: VisibilityCheck, admin: boolean): Promise<SessionSearchResult[]> {
  const bySession = new Map<string, MemoryHit[]>()
  for (const hit of hits) {
    if (hit.archived && !admin) continue
    const group = bySession.get(hit.sessionId)
    if (group) {
      if (group.length < HITS_PER_SESSION) group.push(hit)
    } else bySession.set(hit.sessionId, [hit])
  }
  const results: SessionSearchResult[] = []
  for (const [sessionId, group] of bySession) {
    if (results.length >= limit) break
    const [best] = group
    const filePath = await sessionTranscript(best)
    const live = filePath !== null && transcriptExists(filePath)
    if (!live && !admin) continue
    if (await check(sessionId, live ? lineageFromMeta({ sessionId, parentSessionId: null }, filePath) : undefined) === "hidden") continue
    const address = live ? await storeForPath(filePath)?.sessionAddress(filePath).catch(() => null) : null
    results.push({
      sessionId,
      dirName: address?.dirName ?? null,
      fileName: address?.fileName ?? null,
      title: best.title,
      cwd: best.cwd,
      agentKind: best.agentKind,
      archived: !live,
      hits: group.map(toHit),
    })
  }
  return results
}

async function handleSessionSearch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = readSearchRequest(new URL(req.url ?? "/", "http://localhost").searchParams)
  if (typeof request === "string") return sendJson(res, 400, { error: request })
  const indexer = memoryIndexer()
  const store = indexer?.store() ?? null
  const indexing = indexer?.counts() ?? { pendingFiles: 0, pendingEmbeddings: 0 }
  const check = visibilityFor(req, requestScope(req))
  const answer = (semantic: SemanticStatus, results: SessionSearchResult[] = []) =>
    sendJson(res, 200, { query: request.query, semantic, indexing, results } satisfies SessionSearchResponse)

  const unsearched = (reason: string) => answer(request.mode === "keyword" ? { state: "off" } : { state: "unavailable", reason })
  if (!store) return unsearched("the session index is not available")
  if (check.nothing) return unsearched("no session is visible to you")

  const prose = await searchProse(store, request.query, {
    limit: Math.min(MAX_HITS, request.limit * HITS_PER_SESSION_ASKED),
    mode: request.mode,
    embeddings: indexer?.embedder()?.client ?? null,
    fileExists: transcriptExists,
    ...(request.cwd ? { cwd: request.cwd } : {}),
  })
  answer(prose.semantic, await groupVisible(prose.hits, request.limit, check, mayActHostWide(req)))
}

export function registerSessionSearchRoutes(use: UseFn): void {
  use("/api/session-search", async (req, res, next) => {
    const path = (req.url ?? "").split("?")[0]
    if (req.method !== "GET" || (path !== "" && path !== "/")) return next()
    await handleSessionSearch(req, res)
  })
}
