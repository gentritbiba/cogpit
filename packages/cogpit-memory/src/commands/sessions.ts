/**
 * Sessions command — list recent sessions and find the current session.
 * Ported from the HTTP handlers in routes/sessions-list.ts.
 */

import { join, sep } from "node:path"
import { descriptorFor, type AgentKind } from "../lib/agent-descriptors"
import { parseMaxAge } from "../lib/response"
import { getSessionMeta, getSessionStatus } from "../lib/metadata"
import { listAllSessionFiles, storeFor, storeForPath, type SessionFile } from "../lib/stores"

// ── Types ────────────────────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string
  filePath: string
  timestamp: string
  model: string
  cwd: string
  gitBranch: string
  slug: string
  firstMessage: string
  lastMessage: string
  turnCount: number
  status: string
  mtime: number
  source?: AgentKind
}

export interface SessionsOptions {
  cwd?: string
  limit?: number
  maxAge?: string
}

type SessionMeta = Awaited<ReturnType<typeof getSessionMeta>>

function toSessionSummary(file: SessionFile, meta: SessionMeta, status: string): SessionSummary {
  return {
    sessionId: meta.sessionId,
    filePath: file.path,
    timestamp: meta.timestamp,
    model: meta.model,
    cwd: meta.cwd,
    gitBranch: meta.gitBranch,
    slug: meta.slug,
    firstMessage: meta.firstUserMessage,
    lastMessage: meta.lastUserMessage,
    turnCount: meta.turnCount,
    status,
    mtime: file.mtimeMs,
    // Which root the transcript came out of, which is known before it is read.
    source: storeForPath(file.path)?.kind ?? descriptorFor("claude").kind,
  }
}

// ── listSessions ─────────────────────────────────────────────────────────────

/**
 * List recent sessions across all projects, sorted by mtime descending.
 *
 * Options:
 *   limit   — max results (default 20, max 100)
 *   maxAge  — filter by recency, e.g. "7d", "12h", "30m" (default "7d")
 *   cwd     — optional filter: only return sessions whose cwd matches
 */
export async function listSessions(opts: SessionsOptions = {}): Promise<SessionSummary[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 100)
  const maxAgeMs = parseMaxAge(opts.maxAge ?? "7d")
  const cutoff = Date.now() - maxAgeMs

  const allFiles = listAllSessionFiles(cutoff)
    .filter((file) => !file.isSubagent)

  const results: SessionSummary[] = []

  for (const file of allFiles) {
    if (results.length >= limit) break

    try {
      const [meta, statusInfo] = await Promise.all([
        getSessionMeta(file.path),
        getSessionStatus(file.path),
      ])

      // Apply cwd filter if provided
      if (opts.cwd && meta.cwd !== opts.cwd) continue

      results.push(toSessionSummary(file, meta, statusInfo.status))
    } catch {
      // Skip files that can't be read
    }
  }

  return results
}

// ── currentSession ───────────────────────────────────────────────────────────

/**
 * Find the most recently active session for a given working directory.
 * Returns null if no sessions exist for the given cwd.
 */
export async function currentSession(cwd: string): Promise<SessionSummary | null> {
  const claude = storeFor("claude")
  // Claude encodes the project into its directory name, so its candidates are
  // one readdir away. Every other agent records the project inside the file,
  // which costs a metadata read per candidate.
  const projectDir = join(claude.root(), claude.descriptor.dirName.encode(cwd))
  const direct = claude.list(0, claude.root())
    .filter((file) => !file.isSubagent && file.path.startsWith(projectDir + sep))

  const searched: SessionFile[] = []
  for (const file of listAllSessionFiles(0)) {
    if (file.isSubagent || storeForPath(file.path)?.kind === "claude") continue
    try {
      if ((await getSessionMeta(file.path)).cwd === cwd) searched.push(file)
    } catch {
      continue
    }
  }

  const valid = [...direct, ...searched]
  if (valid.length === 0) return null
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const latest = valid[0]

  if (!latest) return null

  const [meta, statusInfo] = await Promise.all([
    getSessionMeta(latest.path),
    getSessionStatus(latest.path),
  ])

  return toSessionSummary(latest, meta, statusInfo.status)
}
