import Database from "better-sqlite3"
import { promises as fsp } from "node:fs"
import { statSync, watch, mkdirSync, type FSWatcher } from "node:fs"
import { join, basename, dirname } from "node:path"
import { parseSession, getUserMessageText } from "../src/lib/parser"

/** Simple async semaphore for bounding I/O concurrency. */
class Semaphore {
  private running = 0
  private queue: Array<() => void> = []
  constructor(private limit: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.running++; resolve() })
    })
  }

  release(): void {
    this.running--
    const next = this.queue.shift()
    if (next) next()
  }
}

export interface IndexStats {
  dbPath: string
  dbSizeBytes: number
  dbSizeMB: number
  indexedFiles: number
  indexedSessions: number
  indexedSubagents: number
  totalRows: number
  watcherRunning: boolean
  lastFullBuild: string | null
  lastUpdate: string | null
}

export interface SearchHit {
  sessionId: string
  location: string
  snippet: string
  matchCount: number
}

/** Gate for env-controlled perf instrumentation. */
const PERF_LOG = process.env.COGPIT_PERF_LOG === "1"

/** Rows inserted per transaction before yielding back to the event loop. */
const WRITE_BATCH_SIZE = 200

/**
 * Timing knobs for background indexing. Exported as a mutable object so
 * tests can shrink the intervals; production code never mutates it.
 */
export const INDEX_TUNING = {
  /** Quiescence debounce after a file change before reindexing. */
  debounceMs: 2000,
  /** Pacing gap between files during the initial stale sync. */
  syncPacingMs: 50,
  /** Re-check interval while indexing is deferred (live session running). */
  deferRecheckMs: 15_000,
  /** Minimum interval between reindexes of the same file. */
  hotFileMinIntervalLargeMs: 30_000, // files above the size threshold
  hotFileMinIntervalSmallMs: 5_000,
  /** File size above which the large hot-file interval applies. */
  hotFileSizeThreshold: 2 * 1024 * 1024,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class SearchIndex {
  private db: InstanceType<typeof Database>
  private dbPath: string
  projectsDir: string | null = null
  private _watcherRunning = false
  private _lastFullBuild: string | null = null
  private _lastUpdate: string | null = null
  private watcher: FSWatcher | null = null
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastIndexedAt = new Map<string, number>()
  private aborted = false

  /**
   * Optional hook called whenever the watcher detects a changed `.jsonl` file.
   * Consumers (e.g. activeSessionsRoute) can set this to invalidate their own
   * caches. The callback is best-effort: the mtime-key cache self-invalidates
   * anyway, so missing a notification is not catastrophic.
   */
  onFileChanged: ((filePath: string) => void) | null = null

  /**
   * Optional gate: while it returns true, background indexing (initial stale
   * sync and watcher-triggered reindexes) is deferred and re-checked every
   * INDEX_TUNING.deferRecheckMs. Wire this to "any live Claude session running" so the
   * index never competes with an active session for CPU/disk — search keeps
   * serving the existing index and freshness repairs on quiescence.
   */
  shouldDeferIndexing: (() => boolean) | null = null

  constructor(dbPath: string) {
    this.dbPath = dbPath
    // better-sqlite3 will not create missing parent directories. Ensure the
    // target dir exists so a fresh machine (e.g. the dev fallback path
    // ~/.claude/agent-window, never created by anything else) doesn't throw.
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true })
    }
    this.db = new Database(dbPath)
    this.db.pragma("journal_mode = WAL")
    this.db.pragma("synchronous = NORMAL")
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS indexed_files (
      file_path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      session_id TEXT NOT NULL,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT
    )`)

    // Check if FTS table exists before creating (FTS5 doesn't support IF NOT EXISTS)
    const ftsExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='search_content'"
    ).get()

    if (!ftsExists) {
      this.db.exec(`CREATE VIRTUAL TABLE search_content USING fts5(
        session_id,
        source_file,
        location,
        content,
        tokenize = 'trigram'
      )`)
    }
  }

  private statsCache: { stats: IndexStats; at: number } | null = null

  getStats(): IndexStats {
    // COUNT(*) over a large FTS5 table is tens of ms of synchronous work and
    // the stats panel polls this; memoize briefly and invalidate on writes.
    if (this.statsCache && Date.now() - this.statsCache.at < 30_000) {
      return this.statsCache.stats
    }
    const { count: indexedFiles } = this.db.prepare("SELECT COUNT(*) as count FROM indexed_files").get() as { count: number }
    const { count: indexedSessions } = this.db.prepare("SELECT COUNT(*) as count FROM indexed_files WHERE is_subagent = 0").get() as { count: number }
    const { count: indexedSubagents } = this.db.prepare("SELECT COUNT(*) as count FROM indexed_files WHERE is_subagent = 1").get() as { count: number }
    const { count: totalRows } = this.db.prepare("SELECT COUNT(*) as count FROM search_content").get() as { count: number }

    let dbSizeBytes = 0
    try {
      dbSizeBytes = statSync(this.dbPath).size
    } catch {
      // in-memory DB or file missing — size stays 0
    }

    const stats: IndexStats = {
      dbPath: this.dbPath,
      dbSizeBytes,
      dbSizeMB: Math.round((dbSizeBytes / 1024 / 1024) * 10) / 10,
      indexedFiles,
      indexedSessions,
      indexedSubagents,
      totalRows,
      watcherRunning: this._watcherRunning,
      lastFullBuild: this._lastFullBuild,
      lastUpdate: this._lastUpdate,
    }
    this.statsCache = { stats, at: Date.now() }
    return stats
  }

  /**
   * Parse a JSONL file and insert all searchable content into the FTS5 index.
   * Idempotent: deletes old data for the file before re-indexing.
   *
   * Rows are collected first (pure JS), then written in batches of
   * WRITE_BATCH_SIZE inserts per transaction with event-loop yields between
   * batches — a 20 MB session no longer blocks the server's event loop for
   * seconds at a time. The `indexed_files` registration row is written only
   * in the FINAL batch, so an interrupted index leaves no registration and
   * self-heals on the next `updateStale()`.
   */
  async indexFile(
    filePath: string,
    sessionId: string,
    mtimeMs: number,
    opts?: { isSubagent?: boolean; parentSessionId?: string | null }
  ): Promise<void> {
    const t0 = Date.now()
    const content = await fsp.readFile(filePath, "utf-8")
    const session = parseSession(content)

    const isSubagent = opts?.isSubagent ? 1 : 0
    const parentSessionId = opts?.parentSessionId ?? null

    // ── Collect rows (no DB work) ────────────────────────────────────
    const rows: Array<[string, string]> = [] // [location, content]
    const add = (location: string, text: string) => rows.push([location, text])

    const collectToolCalls = (toolCalls: typeof session.turns[0]["toolCalls"], locationPrefix: string): void => {
      for (const tc of toolCalls) {
        const inputStr = JSON.stringify(tc.input)
        if (inputStr && inputStr !== "{}") {
          add(`${locationPrefix}/toolCall/${tc.id}/input`, inputStr)
        }
        if (tc.result) {
          add(`${locationPrefix}/toolCall/${tc.id}/result`, tc.result)
        }
      }
    }

    for (let i = 0; i < session.turns.length; i++) {
      const turn = session.turns[i]
      const prefix = `turn/${i}`

      // User message
      const userText = getUserMessageText(turn.userMessage)
      if (userText.trim()) {
        add(`${prefix}/userMessage`, userText)
      }

      // Assistant text
      const assistantJoined = turn.assistantText.join("\n\n").trim()
      if (assistantJoined) {
        add(`${prefix}/assistantMessage`, assistantJoined)
      }

      // Thinking blocks
      const thinkingText = turn.thinking
        .filter((t) => t.thinking)
        .map((t) => t.thinking)
        .join("\n\n")
        .trim()
      if (thinkingText) {
        add(`${prefix}/thinking`, thinkingText)
      }

      collectToolCalls(turn.toolCalls, prefix)

      // Sub-agent inline activity
      for (const sa of turn.subAgentActivity) {
        const saPrefix = `agent/${sa.agentId}`
        const saText = sa.text.join("\n\n").trim()
        if (saText) {
          add(`${saPrefix}/assistantMessage`, saText)
        }
        const saThinking = sa.thinking
          .filter((t) => t.length > 0)
          .join("\n\n")
          .trim()
        if (saThinking) {
          add(`${saPrefix}/thinking`, saThinking)
        }
        collectToolCalls(sa.toolCalls, saPrefix)
      }

      // Compaction summary
      if (turn.compactionSummary) {
        add(`${prefix}/compactionSummary`, turn.compactionSummary)
      }
    }

    // ── Write in yielded batches ─────────────────────────────────────
    const insert = this.db.prepare(
      "INSERT INTO search_content (session_id, source_file, location, content) VALUES (?, ?, ?, ?)"
    )
    const deleteContent = this.db.prepare(
      "DELETE FROM search_content WHERE source_file = ?"
    )
    const deleteFile = this.db.prepare(
      "DELETE FROM indexed_files WHERE file_path = ?"
    )
    const insertFile = this.db.prepare(
      "INSERT OR REPLACE INTO indexed_files (file_path, mtime_ms, session_id, is_subagent, parent_session_id) VALUES (?, ?, ?, ?, ?)"
    )

    // Delete old data for this specific file (idempotent re-index).
    // Scoped by source_file, not session_id, to avoid deleting content from
    // other files that share the same session_id (e.g. parent + subagent).
    // This also drops the registration row, so an interruption before the
    // final batch leaves the file unregistered → re-indexed next sync.
    this.db.transaction(() => {
      deleteContent.run(filePath)
      deleteFile.run(filePath)
    })()

    for (let i = 0; i < rows.length; i += WRITE_BATCH_SIZE) {
      if (this.aborted) return
      const batch = rows.slice(i, i + WRITE_BATCH_SIZE)
      const isLast = i + WRITE_BATCH_SIZE >= rows.length
      this.db.transaction(() => {
        for (const [location, text] of batch) {
          insert.run(sessionId, filePath, location, text)
        }
        if (isLast) {
          insertFile.run(filePath, mtimeMs, sessionId, isSubagent, parentSessionId)
        }
      })()
      if (!isLast) await new Promise((resolve) => setImmediate(resolve))
    }
    if (rows.length === 0) {
      insertFile.run(filePath, mtimeMs, sessionId, isSubagent, parentSessionId)
    }

    this.lastIndexedAt.set(filePath, Date.now())
    this._lastUpdate = new Date().toISOString()
    this.statsCache = null
    if (PERF_LOG) {
      console.error(
        `[perf][search-index] indexFile ${basename(filePath)} rows=${rows.length} bytes=${content.length} took=${Date.now() - t0}ms`
      )
    }
  }

  /**
   * Query the FTS5 index and return structured search results.
   *
   * - FTS5 trigram tokenizer is case-insensitive by default.
   * - When `caseSensitive` is true, an `AND content GLOB ?` clause is added to
   *   the SQL query — pushing exact-case filtering into SQLite's C runtime
   *   instead of a JS-side post-filter over up to 200 rows.
   * - When `maxAgeMs` is provided, only files whose mtime in `indexed_files`
   *   falls within the window are included (join on source_file).
   * - `sessionId` restricts results to a single session.
   * - `limit` defaults to 200 and is clamped to a max of 200.
   */
  search(
    query: string,
    opts?: {
      limit?: number
      sessionId?: string
      maxAgeMs?: number
      caseSensitive?: boolean
    }
  ): SearchHit[] {
    const limit = Math.min(Math.max(1, opts?.limit ?? 200), 200)
    const sessionId = opts?.sessionId
    const maxAgeMs = opts?.maxAgeMs
    const caseSensitive = opts?.caseSensitive ?? false

    // FTS5 trigram requires the query wrapped in double quotes for phrase matching.
    // Escape any internal double quotes by doubling them.
    const ftsQuery = `"${query.replace(/"/g, '""')}"`

    // snippet() column index 3 = content (session_id=0, source_file=1, location=2, content=3)
    let sql = `
      SELECT sc.session_id, sc.location,
             snippet(search_content, 3, '', '', '...', 40) as snippet
      FROM search_content sc
    `
    const params: (string | number)[] = []
    const conditions: string[] = ["sc.content MATCH ?"]
    params.push(ftsQuery)

    if (maxAgeMs != null) {
      sql += " JOIN indexed_files fi ON fi.file_path = sc.source_file"
      conditions.push("fi.mtime_ms >= ?")
      params.push(Date.now() - maxAgeMs)
    }

    if (sessionId) {
      conditions.push("sc.session_id = ?")
      params.push(sessionId)
    }

    // Push case-sensitive filter into SQL using GLOB (case-sensitive, unlike LIKE).
    // FTS5 trigram is always case-insensitive; GLOB enforces exact-case matching
    // at the SQLite C level, avoiding a JS-side post-filter over up to 200 rows.
    // Escape GLOB metacharacters (* ? [) in the user query to prevent wildcard injection.
    if (caseSensitive) {
      const escapedQuery = query.replace(/[*?[]/g, (c) => `[${c}]`)
      conditions.push("sc.content GLOB ?")
      params.push(`*${escapedQuery}*`)
    }

    sql += " WHERE " + conditions.join(" AND ")
    sql += " ORDER BY sc.rowid DESC"
    sql += " LIMIT ?"
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      session_id: string
      location: string
      snippet: string
    }>

    return rows.map((row) => ({
      sessionId: row.session_id,
      location: row.location,
      snippet: row.snippet,
      matchCount: 1, // FTS5 trigram doesn't expose per-row match count; 1 = "at least one match"
    }))
  }

  /**
   * Count total matching rows and distinct sessions for a query (without LIMIT).
   * Used by the route to report accurate totalHits and sessionsSearched.
   */
  countMatches(
    query: string,
    opts?: {
      sessionId?: string
      maxAgeMs?: number
      caseSensitive?: boolean
    }
  ): { totalHits: number; sessionsSearched: number } {
    const ftsQuery = `"${query.replace(/"/g, '""')}"`

    let sql = `
      SELECT COUNT(*) as total,
             COUNT(DISTINCT sc.session_id) as sessions
      FROM search_content sc
    `
    const params: (string | number)[] = []
    const conditions: string[] = ["sc.content MATCH ?"]
    params.push(ftsQuery)

    if (opts?.maxAgeMs != null) {
      sql += " JOIN indexed_files fi ON fi.file_path = sc.source_file"
      conditions.push("fi.mtime_ms >= ?")
      params.push(Date.now() - opts.maxAgeMs)
    }

    if (opts?.sessionId) {
      conditions.push("sc.session_id = ?")
      params.push(opts.sessionId)
    }

    // Mirror the same GLOB escape + case-sensitive filter used in search().
    // Without this, countMatches over a capped result set includes case-insensitive
    // matches, inflating the reported total when caseSensitive=true.
    if (opts?.caseSensitive) {
      const escapedQuery = query.replace(/[*?[]/g, (c) => `[${c}]`)
      conditions.push("sc.content GLOB ?")
      params.push(`*${escapedQuery}*`)
    }

    sql += " WHERE " + conditions.join(" AND ")

    const row = this.db.prepare(sql).get(...params) as { total: number; sessions: number }
    return { totalHits: row.total, sessionsSearched: row.sessions }
  }

  /**
   * Clear all indexed data and re-index every JSONL file under `projectsDir`.
   * Structure: projectsDir/{projectName}/{sessionId}.jsonl
   * Subagents:  projectsDir/{projectName}/{sessionId}/subagents/agent-{id}.jsonl
   *
   * Stores `projectsDir` as a class field so `rebuild()` can reuse it.
   */
  async buildFull(projectsDir: string): Promise<void> {
    this.projectsDir = projectsDir

    // Clear everything
    this.db.exec("DELETE FROM search_content")
    this.db.exec("DELETE FROM indexed_files")
    this.statsCache = null

    await this.discoverFiles(projectsDir, async (filePath, sessionId, mtimeMs, isSubagent, parentSessionId) => {
      try {
        await this.indexFile(filePath, sessionId, mtimeMs, { isSubagent, parentSessionId })
      } catch {
        // Skip files that fail to parse
      }
    })

    const now = new Date().toISOString()
    this._lastFullBuild = now
    this._lastUpdate = now
  }

  /**
   * Incrementally re-index only files whose mtime has changed since last index.
   * New files (not in indexed_files) are always indexed.
   *
   * Good-neighbor behavior: files are indexed smallest-first (useful results
   * land early), with a pacing gap between files, and the whole sync pauses
   * while `shouldDeferIndexing()` reports a live session.
   */
  async updateStale(projectsDir: string): Promise<void> {
    const t0 = Date.now()
    this.projectsDir = projectsDir

    const getIndexed = this.db.prepare(
      "SELECT mtime_ms FROM indexed_files WHERE file_path = ?"
    )

    const filesToIndex: Array<{
      path: string
      sessionId: string
      mtimeMs: number
      sizeBytes: number
      isSubagent: boolean
      parentSessionId: string | null
    }> = []

    await this.discoverFiles(projectsDir, async (filePath, sessionId, mtimeMs, isSubagent, parentSessionId, sizeBytes) => {
      const existing = getIndexed.get(filePath) as { mtime_ms: number } | undefined
      if (!existing || existing.mtime_ms < mtimeMs) {
        filesToIndex.push({ path: filePath, sessionId, mtimeMs, sizeBytes, isSubagent, parentSessionId })
      }
    })

    // Smallest first: recent/small sessions become searchable early; the big
    // archive files index last when nothing else is contending.
    filesToIndex.sort((a, b) => a.sizeBytes - b.sizeBytes)

    for (const file of filesToIndex) {
      if (this.aborted) return
      while (this.shouldDeferIndexing?.() && !this.aborted) {
        await sleep(INDEX_TUNING.deferRecheckMs)
      }
      if (this.aborted) return
      try {
        await this.indexFile(file.path, file.sessionId, file.mtimeMs, {
          isSubagent: file.isSubagent,
          parentSessionId: file.parentSessionId,
        })
      } catch {
        // Skip files that fail to parse
      }
      await sleep(INDEX_TUNING.syncPacingMs)
    }

    if (filesToIndex.length > 0) {
      this._lastUpdate = new Date().toISOString()
    }
    if (PERF_LOG) {
      console.error(
        `[perf][search-index] updateStale files=${filesToIndex.length} took=${Date.now() - t0}ms`
      )
    }
  }

  /**
   * Re-run buildFull using the previously stored projectsDir.
   * No-op if projectsDir was never set.
   */
  async rebuild(): Promise<void> {
    if (!this.projectsDir) return
    await this.buildFull(this.projectsDir)
  }

  /**
   * Walk the projects directory tree and invoke `callback` for every JSONL file.
   *
   * Directory structure:
   *   projectsDir/
   *     {projectName}/
   *       {sessionId}.jsonl              <- session file
   *       {sessionId}/subagents/
   *         agent-{agentId}.jsonl        <- subagent file (recursive)
   *
   * Skips the "memory" directory.
   * Uses a semaphore (limit 8) to bound concurrent I/O across projects.
   */
  private async discoverFiles(
    projectsDir: string,
    callback: (
      filePath: string,
      sessionId: string,
      mtimeMs: number,
      isSubagent: boolean,
      parentSessionId: string | null,
      sizeBytes: number
    ) => Promise<void>
  ): Promise<void> {
    let entries: string[]
    try {
      entries = await fsp.readdir(projectsDir)
    } catch {
      return
    }

    const sem = new Semaphore(8)

    await Promise.all(
      entries.map(async (projectName) => {
        if (projectName === "memory") return
        const projectDir = join(projectsDir, projectName)

        await sem.acquire()
        try {
          let dirStat: Awaited<ReturnType<typeof fsp.stat>>
          try {
            dirStat = await fsp.stat(projectDir)
            if (!dirStat.isDirectory()) return
          } catch {
            return
          }

          let files: string[]
          try {
            files = await fsp.readdir(projectDir)
          } catch {
            return
          }

          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue
            const filePath = join(projectDir, file)
            const sessionId = basename(file, ".jsonl")
            let fileStat: Awaited<ReturnType<typeof fsp.stat>>
            try {
              fileStat = await fsp.stat(filePath)
            } catch {
              continue
            }

            await callback(filePath, sessionId, fileStat.mtimeMs, false, null, fileStat.size)

            // Discover subagent files recursively
            await this.discoverSubagents(filePath, sessionId, callback, 0, 4)
          }
        } finally {
          sem.release()
        }
      })
    )
  }

  /**
   * Recursively discover subagent JSONL files under the subagents directory
   * that corresponds to `parentPath`.
   *
   * For a parent at `/path/to/session-1.jsonl`, looks for subagents at
   * `/path/to/session-1/subagents/agent-*.jsonl`.
   *
   * Recurses up to `maxDepth` levels (default 4).
   */
  private async discoverSubagents(
    parentPath: string,
    parentSessionId: string,
    callback: (
      filePath: string,
      sessionId: string,
      mtimeMs: number,
      isSubagent: boolean,
      parentSessionId: string | null,
      sizeBytes: number
    ) => Promise<void>,
    depth: number,
    maxDepth: number
  ): Promise<void> {
    if (depth >= maxDepth) return

    // subagents dir lives at: parentPath minus .jsonl extension, plus /subagents
    const subDir = parentPath.replace(/\.jsonl$/, "") + "/subagents"
    let files: string[]
    try {
      files = await fsp.readdir(subDir)
    } catch {
      return
    }

    for (const file of files) {
      if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) continue
      const filePath = join(subDir, file)
      let fileStat: Awaited<ReturnType<typeof fsp.stat>>
      try {
        fileStat = await fsp.stat(filePath)
      } catch {
        continue
      }

      await callback(filePath, parentSessionId, fileStat.mtimeMs, true, parentSessionId, fileStat.size)

      // Recurse deeper for nested subagents
      await this.discoverSubagents(filePath, parentSessionId, callback, depth + 1, maxDepth)
    }
  }

  /**
   * Start watching `projectsDir` for JSONL file changes.
   * Runs `updateStale()` immediately for an initial sync, then sets up
   * `fs.watch` with `{ recursive: true }` (macOS-compatible) to detect
   * subsequent file changes and trigger debounced re-indexing.
   */
  async startWatching(projectsDir: string): Promise<void> {
    this.projectsDir = projectsDir

    // Initial sync — index any files that are new or stale
    await this.updateStale(projectsDir)

    // Watch for changes
    try {
      this.watcher = watch(projectsDir, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return
        this.debouncedReindex(join(projectsDir, filename))
      })
      this._watcherRunning = true
      this.statsCache = null
    } catch (err) {
      console.warn("[search-index] fs.watch failed (recursive may not be supported):", err)
      this._watcherRunning = false
      this.statsCache = null
    }
  }

  /**
   * Stop the file watcher and clear any pending debounce timers.
   * Safe to call even when not watching (no-op).
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
    this._watcherRunning = false
    this.statsCache = null
  }

  /**
   * Private helper: debounce re-indexing of a single file.
   *
   * Three gates run in sequence when the timer fires:
   *   1. 2-second quiescence debounce — coalesces rapid JSONL appends.
   *   2. Deferral — while `shouldDeferIndexing()` is true (live session
   *      running), re-arm and re-check every the defer interval.
   *   3. Hot-file minimum interval — a file already indexed recently is
   *      re-armed for the remaining cooldown instead of re-indexed (30 s for
   *      files > 2 MB, 5 s otherwise). Without this, a streaming session's
   *      multi-MB JSONL was fully re-read, re-parsed, and re-written into
   *      sqlite at every 2 s write gap.
   */
  private debouncedReindex(filePath: string): void {
    // Best-effort: notify consumers (e.g. session-meta cache) immediately so
    // stale entries are dropped even before the 2-second debounce fires.
    this.onFileChanged?.(filePath)

    this.armReindexTimer(filePath, INDEX_TUNING.debounceMs)
  }

  private armReindexTimer(filePath: string, delayMs: number): void {
    const existing = this.debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)

    this.debounceTimers.set(
      filePath,
      setTimeout(() => {
        this.debounceTimers.delete(filePath)
        // Run async I/O in a fire-and-forget IIFE; errors are caught internally.
        void (async () => {
          try {
            if (this.aborted) return

            if (this.shouldDeferIndexing?.()) {
              this.armReindexTimer(filePath, INDEX_TUNING.deferRecheckMs)
              return
            }

            const fileStat = await fsp.stat(filePath)

            // Hot-file cooldown: re-arm for the remainder instead of indexing.
            const minInterval = fileStat.size > INDEX_TUNING.hotFileSizeThreshold
              ? INDEX_TUNING.hotFileMinIntervalLargeMs
              : INDEX_TUNING.hotFileMinIntervalSmallMs
            const lastIndexed = this.lastIndexedAt.get(filePath) ?? 0
            const cooldownLeft = lastIndexed + minInterval - Date.now()
            if (cooldownLeft > 0) {
              this.armReindexTimer(filePath, cooldownLeft)
              return
            }

            // Determine sessionId and subagent status from the file path
            const parts = filePath.split("/")
            const fileName = parts[parts.length - 1]
            const isSubagent = parts.includes("subagents")

            let sessionId: string
            let parentSessionId: string | null = null

            if (isSubagent) {
              // Walk up to find the parent session directory name
              // Structure: .../projects/{project}/{sessionId}/subagents/agent-{id}.jsonl
              const subagentsIdx = parts.lastIndexOf("subagents")
              const parentDir = parts[subagentsIdx - 1]
              sessionId = parentDir
              parentSessionId = parentDir
            } else {
              sessionId = basename(fileName, ".jsonl")
            }

            await this.indexFile(filePath, sessionId, fileStat.mtimeMs, {
              isSubagent,
              parentSessionId,
            })
          } catch {
            // File may have been deleted or is still being written to
          }
        })()
      }, delayMs)
    )
  }

  close(): void {
    this.aborted = true
    this.stopWatching()
    this.db.close()
  }
}
