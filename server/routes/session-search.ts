import type { UseFn } from "../helpers"
import { findJsonlPath, readFile, readdir, stat, join, basename, dirs, sendJson } from "../helpers"
import { parseSession, getUserMessageText } from "../../src/lib/parser"
import type { ParsedSession } from "../../src/lib/types"
import type { SearchIndex } from "../search-index"

// ── Search Index Singleton ───────────────────────────────────────────────────

let searchIndex: SearchIndex | null = null

export function setSearchIndex(index: SearchIndex | null): void {
  searchIndex = index
}

export function getSearchIndex(): SearchIndex | null {
  return searchIndex
}

// ── Types ───────────────────────────────────────────────────────────────────

interface SearchHit {
  location: string
  snippet: string
  matchCount: number
  toolName?: string
  agentName?: string
}

interface SessionSearchResult {
  sessionId: string
  dirName?: string
  hits: SearchHit[]
}

interface SearchResponse {
  query: string
  totalHits: number
  returnedHits: number
  sessionsSearched: number
  results: SessionSearchResult[]
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const SNIPPET_WINDOW = 150

const DEFAULT_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000

function parseMaxAge(raw: string): number {
  const match = raw.match(/^(\d+)(d|h|m)$/)
  if (!match) return DEFAULT_MAX_AGE_MS
  const value = parseInt(match[1], 10)
  switch (match[2]) {
    case "d": return value * 24 * 60 * 60 * 1000
    case "h": return value * 60 * 60 * 1000
    case "m": return value * 60 * 1000
    default: return DEFAULT_MAX_AGE_MS
  }
}

/** Generate a ~150-char snippet centered on the first match. Accepts pre-found index. */
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

// ── Phase 1: File Discovery ─────────────────────────────────────────────────

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

  const nested = await Promise.all(
    projectDirs.map(async (projectDir) => {
      try {
        const files = (await readdir(projectDir)) as string[]
        const jsonlFiles = files.filter(f => f.endsWith(".jsonl"))
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

// ── Phase 2: Raw Text Pre-Filter ────────────────────────────────────────────

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

// ── Phase 3: Structured Walk ────────────────────────────────────────────────

function walkSession(session: ParsedSession, query: string, caseSensitive: boolean, locationPrefix: string = ""): SearchHit[] {
  const hits: SearchHit[] = []

  for (let i = 0; i < session.turns.length; i++) {
    const turn = session.turns[i]
    const prefix = `${locationPrefix}turn/${i}`

    const userText = getUserMessageText(turn.userMessage)
    const userHit = searchField(userText || null, `${prefix}/userMessage`, query, caseSensitive)
    if (userHit) hits.push(userHit)

    const assistantText = turn.assistantText.length > 0 ? turn.assistantText.join("\n\n") : null
    const assistantHit = searchField(assistantText, `${prefix}/assistantMessage`, query, caseSensitive)
    if (assistantHit) hits.push(assistantHit)

    for (const tb of turn.thinking) {
      if (!tb.thinking) continue
      const thinkHit = searchField(tb.thinking, `${prefix}/thinking`, query, caseSensitive)
      if (thinkHit) {
        hits.push(thinkHit)
        break // one hit per thinking group
      }
    }

    for (const tc of turn.toolCalls) {
      const inputStr = JSON.stringify(tc.input)
      const inputHit = searchField(inputStr, `${prefix}/toolCall/${tc.id}/input`, query, caseSensitive, { toolName: tc.name })
      if (inputHit) hits.push(inputHit)

      const resultHit = searchField(tc.result, `${prefix}/toolCall/${tc.id}/result`, query, caseSensitive, { toolName: tc.name })
      if (resultHit) hits.push(resultHit)
    }

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

  const matched = await Promise.all(
    agentFiles.map(async ({ agentId, filePath }) => ({
      agentId,
      filePath,
      rawContent: await rawTextMatch(filePath, query, caseSensitive),
    })),
  )

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

// ── Route Handler ───────────────────────────────────────────────────────────

export function registerSessionSearchRoutes(use: UseFn) {
  use("/api/session-search", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const query = url.searchParams.get("q")
    const sessionId = url.searchParams.get("sessionId")
    const maxAgeRaw = url.searchParams.get("maxAge") || "5d"
    const limitRaw = url.searchParams.get("limit") || "20"
    const caseSensitiveRaw = url.searchParams.get("caseSensitive") || "false"
    const depthRaw = url.searchParams.get("depth") || "4"

    if (!query || query.length < 2) {
      return sendJson(res, 400, { error: "Query parameter 'q' is required and must be at least 2 characters" })
    }

    const limit = Math.min(Math.max(1, parseInt(limitRaw, 10) || 20), 200)
    const caseSensitive = caseSensitiveRaw === "true"
    const depth = Math.min(Math.max(1, parseInt(depthRaw, 10) || 4), 4)
    const maxAgeMs = parseMaxAge(maxAgeRaw)

    // ── Fast path: use search index if available ─────────────────────────
    if (searchIndex) {
      try {
        const indexHits = searchIndex.search(query, {
          limit,
          sessionId: sessionId ?? undefined,
          maxAgeMs,
          caseSensitive,
        })

        const grouped = new Map<string, SearchHit[]>()
        const dirNameMap = new Map<string, string>()
        for (const hit of indexHits) {
          const sessionHits = grouped.get(hit.sessionId) ?? []
          if (!grouped.has(hit.sessionId)) {
            grouped.set(hit.sessionId, sessionHits)
            // Extract dirName from source_file path (first segment before /)
            if (hit.sourceFile) {
              const firstSlash = hit.sourceFile.indexOf("/")
              if (firstSlash > 0) dirNameMap.set(hit.sessionId, hit.sourceFile.slice(0, firstSlash))
            }
          }
          sessionHits.push({
            location: hit.location,
            snippet: hit.snippet,
            matchCount: hit.matchCount,
          })
        }

        const results: SessionSearchResult[] = [...grouped].map(
          ([sessionId, hits]) => ({ sessionId, dirName: dirNameMap.get(sessionId), hits }),
        )

        // Only run the expensive COUNT query when hits were capped by LIMIT.
        // If we got fewer hits than the limit, we already have the full picture.
        let totalHits = indexHits.length
        let sessionsSearched = grouped.size
        if (indexHits.length >= limit) {
          const counts = searchIndex.countMatches(query, {
            sessionId: sessionId ?? undefined,
            maxAgeMs,
          })
          totalHits = counts.totalHits
          sessionsSearched = counts.sessionsSearched
        }

        const response: SearchResponse = {
          query,
          totalHits,
          returnedHits: indexHits.length,
          sessionsSearched,
          results,
        }

        return sendJson(res, 200, response)
      } catch (err) {
        console.warn("[search-index] Index search failed, falling back to raw scan:", err)
      }
    }

    // ── Fallback: raw scan ──────────────────────────────────────────────
    try {
      const files = sessionId ? await discoverSingleSession(sessionId) : await discoverAllSessions(maxAgeMs)

      let totalHits = 0
      let returnedHits = 0
      const results: SessionSearchResult[] = []
      let sessionsSearched = 0

      for (const file of files) {
        if (returnedHits >= limit) break

        const rawContent = await rawTextMatch(file.path, query, caseSensitive)
        sessionsSearched++
        if (!rawContent) continue

        const session = parseSession(rawContent)

        const sessionHits = walkSession(session, query, caseSensitive)
        const subagentHits = await walkSubagentFiles(file.path, query, caseSensitive, 0, depth)
        const allHits = [...sessionHits, ...subagentHits]

        if (allHits.length === 0) continue

        totalHits += allHits.length

        // Extract dirName from path: <PROJECTS_DIR>/<dirName>/<sessionId>.jsonl
        const relPath = file.path.startsWith(dirs.PROJECTS_DIR)
          ? file.path.slice(dirs.PROJECTS_DIR.length + 1)
          : file.path
        const dirName = relPath.split("/")[0] || undefined

        const sessionResult: SessionSearchResult = {
          sessionId: session.sessionId || basename(file.path, ".jsonl"),
          dirName,
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

      const response: SearchResponse = {
        query,
        totalHits,
        returnedHits,
        sessionsSearched,
        results,
      }

      sendJson(res, 200, response)
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })
}
