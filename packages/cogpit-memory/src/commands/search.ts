/**
 * Search command — dual-path session search.
 *
 * Fast path:  FTS5 via SearchIndex (when DB exists or is passed as parameter)
 * Fallback:   3-phase raw-scan (discover -> pre-filter -> structured walk)
 *
 * Ported from server/routes/session-search.ts (FTS5 path) and
 * .worktrees/session-context-server/packages/cogpit-memory/src/routes/session-search.ts (raw-scan).
 */

import { existsSync } from "node:fs"
import { open, readFile, readdir, stat } from "node:fs/promises"
import { join, basename } from "node:path"
import { SearchIndex } from "../lib/search-index"
import { DEFAULT_DB_PATH, dirs } from "../lib/dirs"
import { parseMaxAge } from "../lib/response"
import { findJsonlPath } from "../lib/helpers"
import { parseSession, getUserMessageText } from "../lib/parser"
import type { ParsedSession } from "../lib/types"

// ── Types ────────────────────────────────────────────────────────────────────

export interface SearchOptions {
  sessionId?: string
  maxAge?: string
  limit?: number
  caseSensitive?: boolean
  depth?: number
}

export interface SearchHit {
  location: string
  snippet: string
  matchCount: number
  toolName?: string
  agentName?: string
}

export interface SessionSearchResult {
  sessionId: string
  cwd: string
  hits: SearchHit[]
}

export interface SearchResponse {
  query: string
  totalHits: number
  returnedHits: number
  sessionsSearched: number
  results: SessionSearchResult[]
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

export async function searchSessions(
  query: string,
  opts: SearchOptions,
  searchIndex?: SearchIndex | null,
): Promise<SearchResponse | { error: string }> {
  if (!query || query.length < 2) {
    return { error: "Query must be at least 2 characters" }
  }

  const limit = Math.min(Math.max(1, opts.limit ?? 20), 200)
  const caseSensitive = opts.caseSensitive ?? false
  const maxAgeMs = parseMaxAge(opts.maxAge ?? "5d")
  const depth = Math.min(Math.max(1, opts.depth ?? 4), 4)

  // ── FTS5 fast path ───────────────────────────────────────────────────────
  let index = searchIndex ?? null
  let ownedIndex = false
  if (!index && existsSync(DEFAULT_DB_PATH)) {
    try {
      index = new SearchIndex(DEFAULT_DB_PATH)
      ownedIndex = true
    } catch { /* DB corrupt or locked — fall through to raw scan */ }
  }

  if (index) {
    try {
      const hits = index.search(query, {
        limit,
        sessionId: opts.sessionId,
        maxAgeMs,
        caseSensitive,
      })

      // Group by sessionId
      const grouped = new Map<string, { filePath: string; hits: SearchHit[] }>()
      for (const hit of hits) {
        let entry = grouped.get(hit.sessionId)
        if (!entry) {
          entry = { filePath: hit.filePath, hits: [] }
          grouped.set(hit.sessionId, entry)
        }
        entry.hits.push({
          location: hit.location,
          snippet: hit.snippet,
          matchCount: hit.matchCount,
        })
      }

      const results: SessionSearchResult[] = []
      for (const [sid, entry] of grouped) {
        const cwd = await cwdFromFilePath(entry.filePath)
        results.push({ sessionId: sid, cwd, hits: entry.hits })
      }

      // Only run the expensive COUNT query when hits were capped by LIMIT.
      let totalHits = hits.length
      let sessionsSearched = grouped.size
      if (hits.length >= limit) {
        const counts = index.countMatches(query, {
          sessionId: opts.sessionId,
          maxAgeMs,
        })
        totalHits = counts.totalHits
        sessionsSearched = counts.sessionsSearched
      }

      if (ownedIndex) index.close()

      return {
        query,
        totalHits,
        returnedHits: hits.length,
        sessionsSearched,
        results,
      }
    } catch {
      if (ownedIndex) index.close()
      // Fall through to raw scan
    }
  }

  // ── Fallback: raw-scan (3-phase) ─────────────────────────────────────────
  return rawScanSearch(query, opts.sessionId ?? null, maxAgeMs, limit, caseSensitive, depth)
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
    const fh = await open(filePath, "r")
    try {
      const buf = Buffer.alloc(CWD_READ_BYTES)
      const { bytesRead } = await fh.read(buf, 0, CWD_READ_BYTES, 0)
      const head = buf.subarray(0, bytesRead).toString("utf-8")
      const lines = head.split("\n", 10)
      for (const line of lines) {
        if (!line) continue
        try {
          const obj = JSON.parse(line)
          if (obj.cwd) {
            cwdCache.set(filePath, obj.cwd)
            return obj.cwd
          }
        } catch {}
      }
    } finally {
      await fh.close()
    }
  } catch {}
  cwdCache.set(filePath, "")
  return ""
}

const SNIPPET_WINDOW = 150

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

async function discoverSingleSession(sessionId: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const jsonlPath = await findJsonlPath(sessionId)
  if (!jsonlPath) return []
  const s = await stat(jsonlPath)
  return [{ path: jsonlPath, mtimeMs: s.mtimeMs }]
}

async function discoverAllSessions(maxAgeMs: number): Promise<Array<{ path: string; mtimeMs: number }>> {
  const cutoff = Date.now() - maxAgeMs

  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true }) as import("node:fs").Dirent[]
  } catch {
    return []
  }

  const projectDirs = entries
    .filter(e => e.isDirectory() && e.name !== "memory")
    .map(e => join(dirs.PROJECTS_DIR, e.name))

  // Read all project directories in parallel
  const nested = await Promise.all(
    projectDirs.map(async (projectDir) => {
      try {
        const files = (await readdir(projectDir)) as string[]
        const jsonlFiles = files.filter(f => f.endsWith(".jsonl"))
        // Stat all files in this directory in parallel
        const statResults = await Promise.all(
          jsonlFiles.map(async (f) => {
            const filePath = join(projectDir, f)
            try {
              const s = await stat(filePath)
              return s.mtimeMs >= cutoff ? { path: filePath, mtimeMs: s.mtimeMs } : null
            } catch { return null }
          }),
        )
        return statResults.filter((r): r is { path: string; mtimeMs: number } => r !== null)
      } catch { return [] }
    }),
  )

  const results = nested.flat()
  results.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return results
}

// ── Phase 2: Raw Text Pre-Filter ─────────────────────────────────────────────

async function rawTextMatch(filePath: string, query: string, caseSensitive: boolean): Promise<string | null> {
  try {
    const content = await readFile(filePath, "utf-8")
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
        const subSession = parseSession(rawContent!)
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
  depth: number,
): Promise<SearchResponse> {
  try {
    // Phase 1: Discover files
    const files = sessionId
      ? await discoverSingleSession(sessionId)
      : await discoverAllSessions(maxAgeMs)

    let totalHits = 0
    let returnedHits = 0
    const results: SessionSearchResult[] = []
    let sessionsSearched = 0

    for (const file of files) {
      // Early exit: skip expensive work once limit is reached
      if (returnedHits >= limit) break

      // Phase 2: Raw text pre-filter
      const rawContent = await rawTextMatch(file.path, query, caseSensitive)
      sessionsSearched++
      if (!rawContent) continue

      // Phase 3: Parse and walk
      const session = parseSession(rawContent)

      const sessionHits = walkSession(session, query, caseSensitive)
      const subagentHits = await walkSubagentFiles(file.path, query, caseSensitive, 0, depth)
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
  } catch (err) {
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
