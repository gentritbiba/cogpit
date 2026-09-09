import { Database } from "bun:sqlite"
import { readFileSync, statSync, unlinkSync } from "node:fs"
import { parseSession, getUserMessageText } from "./parser"
import {
  allStores,
  defaultStore,
  storeForPath,
  type SessionFile,
  type SessionFileIdentity,
} from "./stores"

export interface IndexStats {
  dbPath: string
  dbSizeBytes: number
  dbSizeMB: number
  indexedFiles: number
  indexedSessions: number
  indexedSubagents: number
  totalRows: number
  lastFullBuild: string | null
  lastUpdate: string | null
}

export interface SearchHit {
  sessionId: string
  filePath: string
  location: string
  snippet: string
  matchCount: number
}

/** A discovered JSONL file awaiting indexing. */
type FileDescriptor = SessionFile

/**
 * Max characters of content stored per FTS5 row. Capping at 4K chars keeps
 * the index manageable. Tool call results (file reads, grep dumps) are often
 * 50-200KB but the interesting search content is almost always near the start.
 */
const MAX_CONTENT_LEN = 4096

function truncContent(text: string): string {
  return text.length > MAX_CONTENT_LEN ? text.slice(0, MAX_CONTENT_LEN) : text
}

/**
 * Which session a transcript belongs to, asked of the store that owns its root.
 * A path under no known root is read with the default agent's layout, which is
 * what a caller naming its own directory has always meant.
 */
function identifyTranscript(filePath: string): SessionFileIdentity {
  const store = storeForPath(filePath) ?? defaultStore()
  return store.identify(filePath, store.root())
}

export class SearchIndex {
  private db: Database
  private dbPath: string
  private _lastFullBuild: string | null = null
  private _lastUpdate: string | null = null

  constructor(dbPath: string) {
    this.dbPath = dbPath
    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
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
        tokenize = 'unicode61'
      )`)
    }
  }

  getStats(): IndexStats {
    const { count: indexedFiles } = this.db.prepare("SELECT COUNT(*) as count FROM indexed_files").get() as { count: number }
    const { count: indexedSessions } = this.db.prepare("SELECT COUNT(*) as count FROM indexed_files WHERE is_subagent = 0").get() as { count: number }
    const { count: indexedSubagents } = this.db.prepare("SELECT COUNT(*) as count FROM indexed_files WHERE is_subagent = 1").get() as { count: number }
    const { count: totalRows } = this.db.prepare("SELECT COUNT(*) as count FROM search_content").get() as { count: number }

    let dbSizeBytes = 0
    try {
      dbSizeBytes = statSync(this.dbPath).size
    } catch {
      // A missing database has a size of zero until the first index build.
    }

    return {
      dbPath: this.dbPath,
      dbSizeBytes,
      dbSizeMB: Math.round((dbSizeBytes / 1024 / 1024) * 10) / 10,
      indexedFiles,
      indexedSessions,
      indexedSubagents,
      totalRows,
      lastFullBuild: this._lastFullBuild,
      lastUpdate: this._lastUpdate,
    }
  }

  /** Index tool call inputs and results under the given location prefix. */
  private insertToolCalls(
    insert: ReturnType<Database["prepare"]>,
    sessionId: string,
    filePath: string,
    prefix: string,
    toolCalls: ReturnType<typeof parseSession>["turns"][0]["toolCalls"],
  ): void {
    for (const tc of toolCalls) {
      const inputStr = JSON.stringify(tc.input)
      if (inputStr && inputStr !== "{}") {
        insert.run(sessionId, filePath, `${prefix}/toolCall/${tc.id}/input`, truncContent(inputStr))
      }
      if (tc.result) {
        insert.run(sessionId, filePath, `${prefix}/toolCall/${tc.id}/result`, truncContent(tc.result))
      }
    }
  }

  /**
   * Insert all searchable content from a parsed session into the FTS5 index.
   * Shared by both `indexFile` (single-file) and `buildFull` (batch).
   */
  private insertSessionContent(
    insert: ReturnType<Database["prepare"]>,
    sessionId: string,
    filePath: string,
    session: ReturnType<typeof parseSession>,
  ): void {
    for (let i = 0; i < session.turns.length; i++) {
      const turn = session.turns[i]
      const prefix = `turn/${i}`

      const userText = getUserMessageText(turn.userMessage)
      if (userText.trim()) {
        insert.run(sessionId, filePath, `${prefix}/userMessage`, truncContent(userText))
      }

      const assistantJoined = turn.assistantText.join("\n\n").trim()
      if (assistantJoined) {
        insert.run(sessionId, filePath, `${prefix}/assistantMessage`, truncContent(assistantJoined))
      }

      const thinkingText = turn.thinking
        .filter((t) => t.thinking && t.thinking.length > 0)
        .map((t) => t.thinking)
        .join("\n\n")
        .trim()
      if (thinkingText) {
        insert.run(sessionId, filePath, `${prefix}/thinking`, truncContent(thinkingText))
      }

      this.insertToolCalls(insert, sessionId, filePath, prefix, turn.toolCalls)

      for (const sa of turn.subAgentActivity) {
        const saPrefix = `agent/${sa.agentId}`
        const saText = sa.text.join("\n\n").trim()
        if (saText) {
          insert.run(sessionId, filePath, `${saPrefix}/assistantMessage`, truncContent(saText))
        }
        const saThinking = sa.thinking
          .filter((t) => t.length > 0)
          .join("\n\n")
          .trim()
        if (saThinking) {
          insert.run(sessionId, filePath, `${saPrefix}/thinking`, truncContent(saThinking))
        }
        this.insertToolCalls(insert, sessionId, filePath, saPrefix, sa.toolCalls)
      }

      if (turn.compactionSummary) {
        insert.run(sessionId, filePath, `${prefix}/compactionSummary`, truncContent(turn.compactionSummary))
      }
    }
  }

  /**
   * Parse a JSONL file and insert all searchable content into the FTS5 index.
   * Idempotent: deletes old data for the file before re-indexing.
   * All inserts run in a single transaction for performance.
   */
  indexFile(
    filePath: string,
    sessionId?: string,
    mtimeMs?: number,
    opts?: { isSubagent?: boolean; parentSessionId?: string | null }
  ): void {
    // Without an explicit id, ask the store that owns the path — Copilot's file
    // is literally `events.jsonl`, so its name is not its session.
    const resolvedSessionId = sessionId ?? identifyTranscript(filePath).sessionId
    if (mtimeMs == null) {
      mtimeMs = statSync(filePath).mtimeMs
    }

    const content = readFileSync(filePath, "utf-8")
    const session = parseSession(content, { skipStats: true })

    const isSubagent = opts?.isSubagent ? 1 : 0
    const parentSessionId = opts?.parentSessionId ?? null

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

    const txn = this.db.transaction(() => {
      deleteContent.run(filePath)
      deleteFile.run(filePath)
      this.insertSessionContent(insert, resolvedSessionId, filePath, session)
      insertFile.run(filePath, mtimeMs, resolvedSessionId, isSubagent, parentSessionId)
    })

    txn()
    this._lastUpdate = new Date().toISOString()
  }

  pruneMissingFiles(): number {
    const files = this.db.prepare("SELECT file_path FROM indexed_files").all() as Array<{ file_path: string }>
    const missing = files.filter(({ file_path }) => {
      try {
        statSync(file_path)
        return false
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return code === "ENOENT" || code === "ENOTDIR"
      }
    })
    if (missing.length === 0) return 0

    this.db.transaction(() => {
      this.db.exec("CREATE TEMP TABLE missing_transcripts (file_path TEXT PRIMARY KEY)")
      const insert = this.db.prepare("INSERT INTO missing_transcripts VALUES (?)")
      for (const { file_path } of missing) insert.run(file_path)
      this.db.exec("DELETE FROM search_content WHERE source_file IN (SELECT file_path FROM missing_transcripts)")
      this.db.exec("DELETE FROM indexed_files WHERE file_path IN (SELECT file_path FROM missing_transcripts)")
      this.db.exec("DROP TABLE missing_transcripts")
    })()
    return missing.length
  }

  /**
   * Query the FTS5 index and return structured search results.
   *
   * - FTS5 unicode61 tokenizer is case-insensitive by default.
   * - When `caseSensitive` is true, a post-filter checks the original query
   *   against the snippet text (exact case match).
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
      excludeSessionId?: string
      maxAgeMs?: number
      caseSensitive?: boolean
    }
  ): SearchHit[] {
    this.pruneMissingFiles()
    const limit = Math.min(Math.max(1, opts?.limit ?? 200), 200)
    const sessionId = opts?.sessionId
    const maxAgeMs = opts?.maxAgeMs
    const caseSensitive = opts?.caseSensitive ?? false

    // FTS5 unicode61: wrap multi-word queries in double quotes for phrase matching.
    // Escape any internal double quotes by doubling them.
    const ftsQuery = `"${query.replace(/"/g, '""')}"`

    // snippet() column index 3 = content (session_id=0, source_file=1, location=2, content=3)
    let sql = `
      SELECT sc.session_id, sc.source_file, sc.location,
             snippet(search_content, 3, '', '', '...', 120) as snippet
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

    if (opts?.excludeSessionId) {
      conditions.push("sc.session_id != ?")
      params.push(opts.excludeSessionId)
    }

    sql += " WHERE " + conditions.join(" AND ")
    sql += " ORDER BY sc.rowid DESC"
    sql += " LIMIT ?"
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      session_id: string
      source_file: string
      location: string
      snippet: string
    }>

    let hits: SearchHit[] = rows.map((row) => ({
      sessionId: row.session_id,
      filePath: row.source_file,
      location: row.location,
      snippet: row.snippet,
      matchCount: 1, // FTS5 doesn't expose per-row match count; 1 = "at least one match"
    }))

    // Post-filter for case sensitivity — FTS5 unicode61 is case-insensitive by default,
    // so we apply an exact-case check on the snippet text when requested.
    if (caseSensitive) {
      hits = hits.filter((h) => h.snippet.includes(query))
    }

    return hits
  }

  /**
   * Count total matching rows and distinct sessions for a query (without LIMIT).
   * Used by the route to report accurate totalHits and sessionsSearched.
   */
  countMatches(
    query: string,
    opts?: {
      sessionId?: string
      excludeSessionId?: string
      maxAgeMs?: number
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

    if (opts?.excludeSessionId) {
      conditions.push("sc.session_id != ?")
      params.push(opts.excludeSessionId)
    }

    sql += " WHERE " + conditions.join(" AND ")

    const row = this.db.prepare(sql).get(...params) as { total: number; sessions: number }
    return { totalHits: row.total, sessionsSearched: row.sessions }
  }

  /**
   * Clear all indexed data and re-index every transcript, from every agent.
   *
   * Optimized: discovers all files first, then processes them in a single
   * SQLite transaction with pre-prepared statements. This avoids the overhead
   * of 3000+ individual transactions (each forcing a disk sync).
   */
  buildFull(): void {
    // Drop and recreate the DB file — DELETE doesn't reclaim space in SQLite,
    // so reusing a bloated DB file makes rebuilds slower than starting fresh.
    this.db.close()
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(this.dbPath + suffix)
      } catch {
        // The database and SQLite sidecars may not exist yet.
      }
    }
    this.db = new Database(this.dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = OFF")
    this.db.exec("PRAGMA cache_size = -64000")
    this.db.exec("PRAGMA temp_store = MEMORY")
    this.db.exec("PRAGMA mmap_size = 268435456")
    this.initSchema()

    // Discover all files first (fast — just readdir + stat)
    const files: FileDescriptor[] = []

    this.discoverFiles((file) => { files.push(file) })

    // Prepare statements once, run all inserts in a single transaction
    const insert = this.db.prepare(
      "INSERT INTO search_content (session_id, source_file, location, content) VALUES (?, ?, ?, ?)"
    )
    const insertFile = this.db.prepare(
      "INSERT OR REPLACE INTO indexed_files (file_path, mtime_ms, session_id, is_subagent, parent_session_id) VALUES (?, ?, ?, ?, ?)"
    )

    const txn = this.db.transaction(() => {
      for (const file of files) {
        try {
          const content = readFileSync(file.path, "utf-8")
          const session = parseSession(content, { skipStats: true })
          this.insertSessionContent(insert, file.sessionId, file.path, session)
          insertFile.run(file.path, file.mtimeMs, file.sessionId, file.isSubagent ? 1 : 0, file.parentSessionId)
        } catch {
          // Skip files that fail to parse
        }
      }
    })

    txn()

    // Restore safe sync mode for subsequent incremental operations
    this.db.exec("PRAGMA synchronous = NORMAL")
    this._lastFullBuild = new Date().toISOString()
    this._lastUpdate = new Date().toISOString()
  }

  /**
   * Lightweight incremental update for CLI search paths.
   *
   * Still walks and stats all files via `discoverFiles`, but skips DB lookups
   * for files with mtime <= the high-water mark that are already indexed.
   * Caps re-indexing to `maxFiles` to prevent blocking on large backlogs
   * (run `index rebuild` for a full catch-up).
   */
  updateRecent(maxFiles: number = 50): void {
    // Find the high-water mark — newest indexed file mtime
    const row = this.db.prepare(
      "SELECT MAX(mtime_ms) as max_mtime FROM indexed_files"
    ).get() as { max_mtime: number | null } | undefined
    const highWater = row?.max_mtime ?? 0

    const getIndexed = this.db.prepare(
      "SELECT mtime_ms FROM indexed_files WHERE file_path = ?"
    )

    const filesToIndex: FileDescriptor[] = []

    this.discoverFiles((file) => {
      // Skip files that are already indexed with a current mtime
      if (file.mtimeMs <= highWater) {
        const existing = getIndexed.get(file.path) as { mtime_ms: number } | undefined
        if (existing && existing.mtime_ms >= file.mtimeMs) return // already indexed and unchanged
      }
      filesToIndex.push(file)
    })

    // Sort newest first so the most relevant files get indexed within the cap
    filesToIndex.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const batch = filesToIndex.slice(0, maxFiles)

    for (const file of batch) {
      try {
        this.indexFile(file.path, file.sessionId, file.mtimeMs, {
          isSubagent: file.isSubagent,
          parentSessionId: file.parentSessionId,
        })
      } catch {
        // Skip files that fail to parse
      }
    }

    if (batch.length > 0) {
      this._lastUpdate = new Date().toISOString()
    }
  }

  /** Every transcript from every agent, tagged with the session it belongs to. */
  private discoverFiles(callback: (file: FileDescriptor) => void): void {
    for (const store of allStores()) for (const file of store.list(0)) callback(file)
  }

  close(): void {
    this.db.close()
  }
}
