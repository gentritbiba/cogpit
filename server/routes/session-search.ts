import type { IncomingMessage, ServerResponse } from "node:http"
import { searchProse, type SearchMode } from "../../shared/memory/search"
import type { MemoryHit, SemanticStatus } from "../../shared/memory/types"
import type { SessionSearchHit, SessionSearchResponse, SessionSearchResult } from "../../shared/contracts/sessionSearch"
import { allStores, allTopLevelSessions, storeForPath } from "../agents"
import { listedSession, listedSessionId } from "../agents/listedSession"
import { allVisible, mayActHostWide, visibilityFor, type VisibilityCheck } from "../edition"
import { sendJson, type UseFn } from "../http"
import { memoryIndexer } from "../memory"
import { transcriptExists } from "../memory/store"
import { sessionFileFor } from "../sessionCatalog"
import { requestScope } from "./requestScope"

/**
 * GET /api/session-search — ranked hits from the memory store's session text,
 * grouped by the session the UI opens, as far as the caller may see them.
 * The contract is frozen in the semantic-search plan (ROUTE-CONTRACT.md).
 */

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
/** Hits read per session asked for, so grouping still leaves enough sessions. */
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

/**
 * The sessions the caller may see, when the edition restricts them; searched
 * within, so hidden sessions never take a visible one's place. Undefined when
 * every session passes.
 */
async function visibleSessionIds(check: VisibilityCheck): Promise<string[] | undefined> {
  if (check.everything) return undefined
  const listed = await allTopLevelSessions({ skipUnreadable: true })
  return (await allVisible(listed, check, listedSession)).map(({ item }) => listedSessionId(item))
}

/** Hits grouped by session in rank order, with the address to open each; text whose transcript is gone only when `showArchived`. */
async function groupBySession(hits: readonly MemoryHit[], limit: number, showArchived: boolean): Promise<SessionSearchResult[]> {
  const bySession = new Map<string, MemoryHit[]>()
  for (const hit of hits) {
    if (hit.archived && !showArchived) continue
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
    if (!live && !showArchived) continue
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

  const sessionIds = await visibleSessionIds(check)
  const prose = await searchProse(store, request.query, {
    limit: Math.min(MAX_HITS, request.limit * HITS_PER_SESSION_ASKED),
    ...(sessionIds ? { sessionIds } : {}),
    mode: request.mode,
    embeddings: indexer?.embedder()?.client ?? null,
    fileExists: transcriptExists,
    ...(request.cwd ? { cwd: request.cwd } : {}),
  })
  // Archived text has no session left to check a narrower scope against, so only an admin's unscoped search shows it.
  answer(prose.semantic, await groupBySession(prose.hits, request.limit, check.everything && mayActHostWide(req)))
}

export function registerSessionSearchRoutes(use: UseFn): void {
  use("/api/session-search", async (req, res, next) => {
    const path = (req.url ?? "").split("?")[0]
    if (req.method !== "GET" || (path !== "" && path !== "/")) return next()
    await handleSessionSearch(req, res)
  })
}
