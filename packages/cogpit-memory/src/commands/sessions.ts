/**
 * Sessions command — list recent sessions and find the current session.
 * Ported from the HTTP handlers in routes/sessions-list.ts.
 */

import { readdir, stat } from "node:fs/promises"
import { join, basename } from "node:path"
import { dirs } from "../lib/dirs"
import { parseMaxAge } from "../lib/response"
import { getSessionMeta, getSessionStatus } from "../lib/metadata"

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
}

export interface SessionsOptions {
  cwd?: string
  limit?: number
  maxAge?: string
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

  // 1. Read all project directories
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dirs.PROJECTS_DIR, { withFileTypes: true }) as import("node:fs").Dirent[]
  } catch {
    return []
  }

  const projectDirs = entries
    .filter(e => e.isDirectory() && e.name !== "memory")
    .map(e => join(dirs.PROJECTS_DIR, e.name))

  // 2. Discover all .jsonl files, stat them, filter by maxAge
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

  // 3. Sort by mtime descending
  const allFiles = nested.flat()
  allFiles.sort((a, b) => b.mtimeMs - a.mtimeMs)

  // 4. For each file, get metadata + status (up to limit)
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

      results.push({
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
        status: statusInfo.status,
        mtime: file.mtimeMs,
      })
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
 *
 * CWD-to-project-dir derivation: replace `/` and `.` with `-` to get
 * the directory name under ~/.claude/projects/.
 */
export async function currentSession(cwd: string): Promise<SessionSummary | null> {
  // Derive project directory name: /Users/foo/code/bar -> -Users-foo-code-bar
  const projectDirName = cwd.replace(/[/.]/g, "-")
  const projectDir = join(dirs.PROJECTS_DIR, projectDirName)

  let files: string[]
  try {
    files = (await readdir(projectDir)) as string[]
  } catch {
    return null
  }

  const jsonlFiles = files.filter(f => f.endsWith(".jsonl"))
  if (jsonlFiles.length === 0) return null

  // Find the most recently modified .jsonl file
  const statResults = await Promise.all(
    jsonlFiles.map(async (f) => {
      const filePath = join(projectDir, f)
      try {
        const s = await stat(filePath)
        return { path: filePath, mtimeMs: s.mtimeMs }
      } catch {
        return null
      }
    }),
  )

  const valid = statResults.filter((r): r is { path: string; mtimeMs: number } => r !== null)
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const latest = valid[0]

  if (!latest) return null

  const [meta, statusInfo] = await Promise.all([
    getSessionMeta(latest.path),
    getSessionStatus(latest.path),
  ])

  return {
    sessionId: meta.sessionId,
    filePath: latest.path,
    timestamp: meta.timestamp,
    model: meta.model,
    cwd: meta.cwd,
    gitBranch: meta.gitBranch,
    slug: meta.slug,
    firstMessage: meta.firstUserMessage,
    lastMessage: meta.lastUserMessage,
    turnCount: meta.turnCount,
    status: statusInfo.status,
    mtime: latest.mtimeMs,
  }
}
