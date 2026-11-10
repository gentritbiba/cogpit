/**
 * Search command: one ranked list from two stores.
 *
 * Prose (prompts, replies, thinking, summaries) is ranked by BM25 in the
 * memory store, across all time unless --max-age is given. Tool input and
 * output come from the FTS5 tool index as exact-phrase hits within --max-age
 * (default 5d). Reciprocal rank fusion merges the lists. Both stores are
 * brought up to date first, within a time budget, from one parse per file.
 *
 * When the tool index cannot be used, a raw scan of the transcripts stands in
 * for it; when the memory store cannot be used, the tool index answers for
 * prose too, as it did before the memory store existed.
 */

import { existsSync, mkdirSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join, basename, dirname } from "node:path"
import { SearchIndex, type SearchHit as ToolIndexHit } from "../lib/search-index"
import { DEFAULT_DB_PATH } from "../lib/dirs"
import { MAX_AGE_HELP, parseMaxAge } from "../lib/response"
import { findSessionFile, listAllSessionFiles, subagentIdForPath, workerInstanceId } from "../lib/stores"
import { formatForText } from "../lib/agents"
import { getUserMessageText } from "../lib/parser"
import { parseTranscript } from "../lib/read-session"
import { openTranscript, readTranscriptText } from "../lib/transcriptFile"
import { openMemoryStore, transcriptExists } from "../lib/memory-store"
import { rebuildToolIndex, syncTranscripts, type SyncSummary } from "../lib/sync"
import { rrfScore } from "../lib/memory/fusion"
import { clampSearchLimit, searchProse, type ProseSearchResult } from "../lib/memory/search"
import type { MemoryStore } from "../lib/memory/store"
import type { ChunkKind, MatchKind, MemoryHit, SemanticStatus } from "../lib/memory/types"
import type { ParsedSession } from "../lib/types"

// ── Types ────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  sessionId?: string
  excludeSessionId?: string
  maxAge?: string
  limit?: number
  caseSensitive?: boolean
}

export interface SearchHit {
  location: string
  snippet: string
  matchCount: number
  toolName?: string
  agentName?: string
  /** How the hit matched. Absent on raw-scan hits. */
  match?: MatchKind
  /** Fused score; higher is better. Absent on raw-scan hits. */
  score?: number
  kind?: ChunkKind | "tool_input" | "tool_result"
  timestamp?: string
  /** For `context <id> --turn`; the subagent's turn when `agent` is set. */
  turn?: number
  /** For `context <id> --agent`. */
  agent?: string
  /** The transcript is gone; `text` is all that is left of the passage. */
  archived?: true
  text?: string
  /** Written on someone's behalf (crew chat, task wake-ups, other agents). */
  automated?: true
  /** Identical passages in other sessions (forks) folded into this hit. */
  duplicates?: number
}

export interface SessionSearchResult {
  sessionId: string
  cwd: string
  title?: string
  hits: SearchHit[]
}

export interface SearchResponse {
  query: string
  totalHits: number
  returnedHits: number
  sessionsSearched: number
  results: SessionSearchResult[]
  semantic?: SemanticStatus["state"]
  semanticReason?: string
  warnings?: string[]
}

/** What a search spends bringing the stores up to date before it answers. */
export const SEARCH_SYNC_BUDGET_MS = 2000

/** Each list contributes this many candidates per requested hit before fusion. */
const CANDIDATES_PER_HIT = 3

interface RankedHit {
  sessionId: string
  cwd: string | null
  filePath: string
  title: string | null
  score: number
  prose: boolean
  hit: SearchHit
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * `searchIndex` and `memory`: undefined opens, refreshes and closes the
 * default store; null skips it; an instance is searched as it is.
 */
export async function searchSessions(
  query: string,
  opts: SearchOptions,
  searchIndex?: SearchIndex | null,
  memory?: MemoryStore | null,
): Promise<SearchResponse | { error: string }> {
  if (!query || query.length < 2) {
    return { error: "Query must be at least 2 characters" }
  }
  const maxAge = opts.maxAge === undefined ? undefined : parseMaxAge(opts.maxAge)
  if (maxAge === null) return { error: `Invalid --max-age "${opts.maxAge}": ${MAX_AGE_HELP}` }

  const limit = clampSearchLimit(opts.limit)
  const caseSensitive = opts.caseSensitive ?? false
  const toolMaxAgeMs = maxAge ?? parseMaxAge("5d")!
  const warnings: string[] = []

  const opened = openStores(searchIndex, memory, warnings)
  try {
    const { index, memoryStore } = opened
    const sync = refresh(opened)
    if (sync?.pending) warnings.push(`${sync.pending} transcripts are not indexed yet; run \`cogpit-memory index sync\` to finish.`)

    const prose = memoryStore
      ? await searchProse(memoryStore, query, {
        limit: limit * CANDIDATES_PER_HIT,
        sessionId: opts.sessionId,
        excludeSessionId: opts.excludeSessionId,
        instanceId: workerInstanceId() ?? undefined,
        sinceMs: maxAge === undefined ? undefined : Date.now() - maxAge,
        fileExists: transcriptExists,
      })
      : null
    const proseHits = (prose?.hits ?? []).filter((hit) => !caseSensitive || hit.text.includes(query))

    let tools: { hits: ToolIndexHit[]; total: number; sessions: number } | null = null
    if (index) {
      try {
        const unsynced = memoryStore ? proseNotInMemory(index, memoryStore) : null
        tools = toolIndexHits(index, query, {
          limit: limit * CANDIDATES_PER_HIT,
          sessionId: opts.sessionId,
          excludeSessionId: opts.excludeSessionId,
          maxAgeMs: toolMaxAgeMs,
          caseSensitive,
          proseFrom: unsynced ?? undefined,
        })
      } catch {
        tools = null
      }
    }

    // A session the index has not seen yet (or an index that cannot be read) is scanned raw.
    const scanned = !tools || (opts.sessionId && tools.hits.length === 0 && proseHits.length === 0)
    if (scanned) {
      const raw = await rawScanSearch(query, opts.sessionId ?? null, toolMaxAgeMs, limit, caseSensitive, opts.excludeSessionId)
      if (!memoryStore || proseHits.length === 0) return withStatus(raw, prose, warnings)
      return withStatus(await fuse(query, limit, proseHits, rawToolHits(raw), prose, null), prose, warnings)
    }
    return withStatus(await fuse(query, limit, proseHits, tools!.hits.map(toToolRanked), prose, tools), prose, warnings)
  } finally {
    opened.close()
  }
}

// ── Stores ───────────────────────────────────────────────────────────────────

interface OpenedStores {
  index: SearchIndex | null
  memoryStore: MemoryStore | null
  /** Set when this search opened the index, so it may refresh it. */
  ownIndex: boolean
  ownMemory: boolean
  indexWasMissing: boolean
  close(): void
}

function openStores(searchIndex: SearchIndex | null | undefined, memory: MemoryStore | null | undefined, warnings: string[]): OpenedStores {
  let index = searchIndex ?? null
  let memoryStore = memory ?? null
  let indexWasMissing = false
  if (searchIndex === undefined) {
    try {
      indexWasMissing = !existsSync(DEFAULT_DB_PATH)
      if (indexWasMissing) mkdirSync(dirname(DEFAULT_DB_PATH), { recursive: true })
      index = new SearchIndex(DEFAULT_DB_PATH)
    } catch { /* DB corrupt or locked: the raw scan stands in. */ }
  }
  if (memory === undefined) {
    try {
      memoryStore = openMemoryStore()
    } catch (error) {
      warnings.push(`Prose ranking is off: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    index,
    memoryStore,
    ownIndex: searchIndex === undefined && index !== null,
    ownMemory: memory === undefined && memoryStore !== null,
    indexWasMissing,
    close() {
      if (this.ownIndex) index?.close()
      if (this.ownMemory) memoryStore?.close()
    },
  }
}

function refresh(stores: OpenedStores): SyncSummary | null {
  const index = stores.ownIndex ? stores.index : null
  const memory = stores.ownMemory ? stores.memoryStore : null
  try {
    if (index && stores.indexWasMissing) return rebuildToolIndex(index, memory)
    if (!index && !memory) return null
    return syncTranscripts({ index, memory, budgetMs: SEARCH_SYNC_BUDGET_MS })
  } catch {
    // A stale store still answers; the next search tries again.
    return null
  }
}

/**
 * Transcripts the tool index has and the memory store has not taken in yet,
 * such as a backlog after upgrading: their prose still answers from the tool
 * index until the memory store catches up.
 */
function proseNotInMemory(index: SearchIndex, memory: MemoryStore): Set<string> {
  const synced = memory.syncedFiles()
  return new Set([...index.indexedFiles().keys()].filter((path) => !synced.has(path)))
}

function isToolRow(location: string): boolean {
  return location.includes("toolCall/")
}

function toolIndexHits(index: SearchIndex, query: string, options: Parameters<SearchIndex["search"]>[1] & { limit: number }) {
  const hits = index.search(query, options)
  if (hits.length < options.limit) return { hits, total: hits.length, sessions: new Set(hits.map((hit) => hit.sessionId)).size }
  const counts = index.countMatches(query, options)
  return { hits, total: counts.totalHits, sessions: counts.sessionsSearched }
}

// ── Fusion ───────────────────────────────────────────────────────────────────

function toProseRanked(hit: MemoryHit): RankedHit {
  return {
    sessionId: hit.sessionId,
    cwd: hit.cwd,
    filePath: hit.sourceFile,
    title: hit.title,
    score: hit.score,
    prose: true,
    hit: {
      location: hit.location,
      snippet: hit.snippet,
      matchCount: hit.matchCount,
      match: hit.match,
      score: hit.score,
      kind: hit.kind,
      ...(hit.timestamp ? { timestamp: hit.timestamp } : {}),
      ...(hit.inlineAgentId ? {} : { turn: hit.turn }),
      ...(hit.agentId ? { agent: hit.agentId } : {}),
      ...(hit.archived ? { archived: true as const, text: hit.text } : {}),
      ...(hit.automated ? { automated: true as const } : {}),
      ...(hit.duplicates ? { duplicates: hit.duplicates } : {}),
    },
  }
}

/** Where a tool row sits: `turn/<n>/…` in the file (a subagent's own when it is one), or inline `agent/<id>/…`. */
function toolPlace(location: string, filePath: string): Pick<SearchHit, "turn" | "agent" | "kind"> {
  const kind = !isToolRow(location) ? undefined : location.endsWith("/input") ? "tool_input" as const : "tool_result" as const
  const turn = /^turn\/(\d+)\//.exec(location)?.[1]
  if (turn === undefined) return kind ? { kind } : {}
  const agent = subagentIdForPath(filePath)
  return { kind, turn: Number(turn), ...(agent ? { agent } : {}) }
}

function toToolRanked(hit: ToolIndexHit, index: number): RankedHit {
  const score = rrfScore([index + 1])
  return {
    sessionId: hit.sessionId,
    cwd: null,
    filePath: hit.filePath,
    title: null,
    score,
    prose: false,
    hit: { location: hit.location, snippet: hit.snippet, matchCount: hit.matchCount, match: "keyword", score, ...toolPlace(hit.location, hit.filePath) },
  }
}

/** Tool hits from a raw scan, ranked in scan order (newest session first). */
function rawToolHits(raw: SearchResponse): RankedHit[] {
  return raw.results.flatMap((result) => result.hits
    .filter((hit) => hit.location.includes("/toolCall/"))
    .map((hit) => ({ sessionId: result.sessionId, cwd: result.cwd, filePath: "", title: null, score: 0, prose: false, hit })))
    .map((ranked, index) => {
      const score = rrfScore([index + 1])
      return { ...ranked, score, hit: { ...ranked.hit, match: "keyword" as const, score } }
    })
}

async function fuse(
  query: string,
  limit: number,
  proseHits: readonly MemoryHit[],
  toolHits: readonly RankedHit[],
  prose: ProseSearchResult | null,
  tools: { total: number; sessions: number } | null,
): Promise<SearchResponse> {
  // Equal scores keep prose first: the list order is the tie-break.
  const ranked = [...proseHits.map(toProseRanked), ...toolHits]
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => b.entry.score - a.entry.score || a.order - b.order)
    .slice(0, limit)
    .map(({ entry }) => entry)

  const grouped = new Map<string, SessionSearchResult>()
  for (const entry of ranked) {
    let result = grouped.get(entry.sessionId)
    if (!result) {
      result = { sessionId: entry.sessionId, cwd: entry.cwd ?? await cwdFromFilePath(entry.filePath), hits: [] }
      grouped.set(entry.sessionId, result)
    }
    if (!result.title && entry.title) result.title = entry.title
    result.hits.push({ ...entry.hit, ...(entry.hit.score !== undefined ? { score: roundScore(entry.hit.score) } : {}) })
  }

  const proseTotal = prose?.keywordHits ?? 0
  const toolTotal = tools?.total ?? toolHits.length
  const candidateSessions = new Set([...proseHits.map((hit) => hit.sessionId), ...toolHits.map((hit) => hit.sessionId)]).size
  const capped = proseTotal > proseHits.length || toolTotal > toolHits.length
  return {
    query,
    totalHits: proseTotal + toolTotal,
    returnedHits: ranked.length,
    // Exact while every match is a candidate; past that, sessions matched in both lists count twice.
    sessionsSearched: capped ? Math.max(candidateSessions, (prose?.sessionsMatched ?? 0) + (tools?.sessions ?? 0)) : candidateSessions,
    results: [...grouped.values()].map(({ sessionId, cwd, title, hits }) => ({ sessionId, cwd, ...(title ? { title } : {}), hits })),
  }
}

function roundScore(score: number): number {
  return Math.round(score * 1e6) / 1e6
}

function withStatus(response: SearchResponse, prose: ProseSearchResult | null, warnings: string[]): SearchResponse {
  const semantic: SemanticStatus = prose?.semantic ?? { state: "unavailable", reason: "the memory store is unavailable" }
  return {
    ...response,
    semantic: semantic.state,
    ...(semantic.reason ? { semanticReason: semantic.reason } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read the cwd from the first few lines of a session JSONL file.
 * The cwd is stored in the session metadata near the top of the file.
 * Uses a partial read (4 KB) to avoid loading multi-MB session files.
 * Caches results to avoid re-reading the same file.
 */
const CWD_READ_BYTES = 4096
const cwdCache = new Map<string, string>()
async function cwdFromFilePath(filePath: string): Promise<string> {
  const cached = cwdCache.get(filePath)
  if (cached !== undefined) return cached

  try {
    const fh = await openTranscript(filePath)
    try {
      const buf = Buffer.alloc(CWD_READ_BYTES)
      const { bytesRead } = await fh.read(buf, 0, CWD_READ_BYTES, 0)
      const head = buf.subarray(0, bytesRead).toString("utf-8")
      const lines = head.split("\n", 10).filter(Boolean)
      const cwd = formatForText(lines.join("\n")).metadataFromLines(lines).cwd
      if (cwd) {
        cwdCache.set(filePath, cwd)
        return cwd
      }
    } finally {
      await fh.close()
    }
  } catch {
    // Unreadable session metadata has no usable cwd.
  }
  cwdCache.set(filePath, "")
  return ""
}

const SNIPPET_WINDOW = 150
/** How many levels of sub-agent transcripts a raw scan follows. */
const MAX_SUBAGENT_DEPTH = 4

/** Generate a ~150-char snippet centered on the first match. */
function generateSnippet(text: string, matchIdx: number, queryLen: number): string {
  if (matchIdx === -1) return text.slice(0, SNIPPET_WINDOW)

  const halfWindow = Math.floor((SNIPPET_WINDOW - queryLen) / 2)
  const start = Math.max(0, matchIdx - halfWindow)
  const end = Math.min(text.length, start + SNIPPET_WINDOW)
  const adjustedStart = Math.max(0, end - SNIPPET_WINDOW)

  let snippet = text.slice(adjustedStart, end)
  if (adjustedStart > 0) snippet = "..." + snippet
  if (end < text.length) snippet = snippet + "..."
  return snippet
}

/** Count all occurrences of needle in haystack (both already case-normalized). */
function countMatches(haystack: string, needle: string): number {
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

/** Search a text field — normalize case once, then generate snippet + count. */
function searchField(
  text: string | null,
  location: string,
  query: string,
  caseSensitive: boolean,
  extras?: { toolName?: string; agentName?: string },
): SearchHit | null {
  if (!text) return null
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const idx = haystack.indexOf(needle)
  if (idx === -1) return null

  return {
    location,
    snippet: generateSnippet(text, idx, query.length),
    matchCount: countMatches(haystack, needle),
    ...(extras?.toolName && { toolName: extras.toolName }),
    ...(extras?.agentName && { agentName: extras.agentName }),
  }
}

// ── Phase 1: File Discovery ──────────────────────────────────────────────────

async function discoverSingleSession(sessionId: string): Promise<Array<{ path: string; mtimeMs: number; sessionId: string }>> {
  const jsonlPath = await findSessionFile(sessionId)
  if (!jsonlPath) return []
  const s = await stat(jsonlPath)
  return [{ path: jsonlPath, mtimeMs: s.mtimeMs, sessionId }]
}

/**
 * Every agent's transcripts, newest first. Driven by the one store registry, so
 * the raw scan cannot cover a different set of agents from the FTS index — the
 * disagreement that made Codex sessions unfindable by either path.
 */
function discoverAllSessions(maxAgeMs: number): Array<{ path: string; mtimeMs: number; sessionId: string }> {
  return listAllSessionFiles(Date.now() - maxAgeMs)
    .filter((file) => !file.isSubagent)
    .map((file) => ({ path: file.path, mtimeMs: file.mtimeMs, sessionId: file.sessionId }))
}

// ── Phase 2: Raw Text Pre-Filter ─────────────────────────────────────────────

async function rawTextMatch(filePath: string, query: string, caseSensitive: boolean): Promise<string | null> {
  try {
    const content = await readTranscriptText(filePath)
    const haystack = caseSensitive ? content : content.toLowerCase()
    const needle = caseSensitive ? query : query.toLowerCase()
    if (haystack.includes(needle)) return content
    return null
  } catch {
    return null
  }
}

// ── Phase 3: Structured Walk ─────────────────────────────────────────────────

function walkSession(session: ParsedSession, query: string, caseSensitive: boolean, locationPrefix: string = ""): SearchHit[] {
  const hits: SearchHit[] = []

  for (let i = 0; i < session.turns.length; i++) {
    const turn = session.turns[i]
    const prefix = `${locationPrefix}turn/${i}`

    // User message
    const userText = getUserMessageText(turn.userMessage)
    const userHit = searchField(userText || null, `${prefix}/userMessage`, query, caseSensitive)
    if (userHit) hits.push(userHit)

    // Assistant text
    const assistantText = turn.assistantText.length > 0 ? turn.assistantText.join("\n\n") : null
    const assistantHit = searchField(assistantText, `${prefix}/assistantMessage`, query, caseSensitive)
    if (assistantHit) hits.push(assistantHit)

    // Thinking blocks
    for (const tb of turn.thinking) {
      if (!tb.thinking) continue
      const thinkHit = searchField(tb.thinking, `${prefix}/thinking`, query, caseSensitive)
      if (thinkHit) {
        hits.push(thinkHit)
        break // one hit per thinking group
      }
    }

    // Tool calls (input + result)
    for (const tc of turn.toolCalls) {
      const inputStr = JSON.stringify(tc.input)
      const inputHit = searchField(inputStr, `${prefix}/toolCall/${tc.id}/input`, query, caseSensitive, { toolName: tc.name })
      if (inputHit) hits.push(inputHit)

      const resultHit = searchField(tc.result, `${prefix}/toolCall/${tc.id}/result`, query, caseSensitive, { toolName: tc.name })
      if (resultHit) hits.push(resultHit)
    }

    // Sub-agent activity (inline data from parent session)
    for (const sa of turn.subAgentActivity) {
      const saPrefix = `${locationPrefix}agent/${sa.agentId}/`

      const saText = sa.text.length > 0 ? sa.text.join("\n\n") : null
      const saTextHit = searchField(saText, `${saPrefix}assistantMessage`, query, caseSensitive, {
        agentName: sa.agentName ?? undefined,
      })
      if (saTextHit) hits.push(saTextHit)

      for (const t of sa.thinking) {
        const tHit = searchField(t, `${saPrefix}thinking`, query, caseSensitive, { agentName: sa.agentName ?? undefined })
        if (tHit) {
          hits.push(tHit)
          break
        }
      }

      for (const tc of sa.toolCalls) {
        const inputStr = JSON.stringify(tc.input)
        const inputHit = searchField(inputStr, `${saPrefix}toolCall/${tc.id}/input`, query, caseSensitive, {
          toolName: tc.name,
          agentName: sa.agentName ?? undefined,
        })
        if (inputHit) hits.push(inputHit)

        const resultHit = searchField(tc.result, `${saPrefix}toolCall/${tc.id}/result`, query, caseSensitive, {
          toolName: tc.name,
          agentName: sa.agentName ?? undefined,
        })
        if (resultHit) hits.push(resultHit)
      }
    }

    // Compaction summary
    if (turn.compactionSummary) {
      const compHit = searchField(turn.compactionSummary, `${prefix}/compactionSummary`, query, caseSensitive)
      if (compHit) hits.push(compHit)
    }
  }

  return hits
}

async function walkSubagentFiles(
  parentJsonlPath: string,
  query: string,
  caseSensitive: boolean,
  currentDepth: number,
  maxDepth: number,
): Promise<SearchHit[]> {
  if (currentDepth >= maxDepth) return []

  const subDir = parentJsonlPath.replace(/\.jsonl$/, "") + "/subagents"
  let files: string[]
  try {
    files = (await readdir(subDir)) as string[]
  } catch {
    return []
  }

  const agentFiles = files
    .filter(f => f.startsWith("agent-") && f.endsWith(".jsonl"))
    .map(f => ({
      agentId: f.slice("agent-".length, -".jsonl".length),
      filePath: join(subDir, f),
    }))

  // Pre-filter all agent files in parallel
  const matched = await Promise.all(
    agentFiles.map(async ({ agentId, filePath }) => ({
      agentId,
      filePath,
      rawContent: await rawTextMatch(filePath, query, caseSensitive),
    })),
  )

  // Walk matching files in parallel
  const hitArrays = await Promise.all(
    matched
      .filter(m => m.rawContent)
      .map(async ({ agentId, filePath, rawContent }) => {
        const subSession = parseTranscript(rawContent!, filePath)
        const subHits = walkSession(subSession, query, caseSensitive, `agent/${agentId}/`)
        const nestedHits = await walkSubagentFiles(filePath, query, caseSensitive, currentDepth + 1, maxDepth)
        return [...subHits, ...nestedHits]
      }),
  )

  return hitArrays.flat()
}

// ── Raw-Scan Search ──────────────────────────────────────────────────────────

async function rawScanSearch(
  query: string,
  sessionId: string | null,
  maxAgeMs: number,
  limit: number,
  caseSensitive: boolean,
  excludeSessionId?: string,
): Promise<SearchResponse> {
  try {
    // Phase 1: Discover files
    const files = sessionId
      ? await discoverSingleSession(sessionId)
      : discoverAllSessions(maxAgeMs)

    let totalHits = 0
    let returnedHits = 0
    const results: SessionSearchResult[] = []
    let sessionsSearched = 0

    for (const file of files) {
      if (file.sessionId === excludeSessionId) continue
      // Early exit: skip expensive work once limit is reached
      if (returnedHits >= limit) break

      // Phase 2: Raw text pre-filter
      const rawContent = await rawTextMatch(file.path, query, caseSensitive)
      sessionsSearched++
      if (!rawContent) continue

      // Phase 3: Parse and walk
      const session = parseTranscript(rawContent, file.path)

      const sessionHits = walkSession(session, query, caseSensitive)
      const subagentHits = await walkSubagentFiles(file.path, query, caseSensitive, 0, MAX_SUBAGENT_DEPTH)
      const allHits = [...sessionHits, ...subagentHits]

      if (allHits.length === 0) continue

      totalHits += allHits.length

      const sessionResult: SessionSearchResult = {
        sessionId: session.sessionId || basename(file.path, ".jsonl"),
        cwd: session.cwd || "",
        hits: [],
      }

      for (const hit of allHits) {
        if (returnedHits < limit) {
          sessionResult.hits.push(hit)
          returnedHits++
        }
      }

      if (sessionResult.hits.length > 0) {
        results.push(sessionResult)
      }
    }

    return {
      query,
      totalHits,
      returnedHits,
      sessionsSearched,
      results,
    }
  } catch {
    // Return an empty successful response on unexpected errors rather than
    // letting them bubble up — the caller can check results.length === 0.
    return {
      query,
      totalHits: 0,
      returnedHits: 0,
      sessionsSearched: 0,
      results: [],
    }
  }
}
