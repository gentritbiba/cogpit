import Database from "better-sqlite3"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, basename } from "node:path"
import { parseSession, getUserMessageText } from "../src/lib/parser"

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

export class SearchIndex {
  private db: InstanceType<typeof Database>
  private dbPath: string
  projectsDir: string | null = null
  private _watcherRunning = false
  private _lastFullBuild: string | null = null
  private _lastUpdate: string | null = null

  constructor(dbPath: string) {
    this.dbPath = dbPath
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

  getStats(): IndexStats {
    const { count: indexedFiles } = this.db.prepare("SELECT COUNT(*) as count FROM indexed_files").get() as { count: number }
    const { count: indexedSessions } = this.db.prepare("SELECT COUNT(*) as count FROM indexed_files WHERE is_subagent = 0").get() as { count: number }
    const { count: indexedSubagents } = this.db.prepare("SELECT COUNT(*) as count FROM indexed_files WHERE is_subagent = 1").get() as { count: number }
    const { count: totalRows } = this.db.prepare("SELECT COUNT(*) as count FROM search_content").get() as { count: number }

    let dbSizeBytes = 0
    try {
      dbSizeBytes = statSync(this.dbPath).size
    } catch {}

    return {
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
  }

  /**
   * Parse a JSONL file and insert all searchable content into the FTS5 index.
   * Idempotent: deletes old data for the file before re-indexing.
   * All inserts run in a single transaction for performance.
   */
  indexFile(
    filePath: string,
    sessionId: string,
    mtimeMs: number,
    opts?: { isSubagent?: boolean; parentSessionId?: string | null }
  ): void {
    const content = readFileSync(filePath, "utf-8")
    const session = parseSession(content)

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
      // Delete old data for this specific file (idempotent re-index)
      // Scoped by source_file, not session_id, to avoid deleting content from
      // other files that share the same session_id (e.g. parent + subagent)
      deleteContent.run(filePath)
      deleteFile.run(filePath)

      for (let i = 0; i < session.turns.length; i++) {
        const turn = session.turns[i]
        const prefix = `turn/${i}`

        // User message
        const userText = getUserMessageText(turn.userMessage)
        if (userText.trim()) {
          insert.run(sessionId, filePath, `${prefix}/userMessage`, userText)
        }

        // Assistant text
        const assistantJoined = turn.assistantText.join("\n\n").trim()
        if (assistantJoined) {
          insert.run(sessionId, filePath, `${prefix}/assistantMessage`, assistantJoined)
        }

        // Thinking blocks
        const thinkingText = turn.thinking
          .filter((t) => t.thinking && t.thinking.length > 0)
          .map((t) => t.thinking)
          .join("\n\n")
          .trim()
        if (thinkingText) {
          insert.run(sessionId, filePath, `${prefix}/thinking`, thinkingText)
        }

        // Tool calls — inputs and results
        for (const tc of turn.toolCalls) {
          const inputStr = JSON.stringify(tc.input)
          if (inputStr && inputStr !== "{}") {
            insert.run(sessionId, filePath, `${prefix}/toolCall/${tc.id}/input`, inputStr)
          }
          if (tc.result) {
            insert.run(sessionId, filePath, `${prefix}/toolCall/${tc.id}/result`, tc.result)
          }
        }

        // Sub-agent inline activity
        for (const sa of turn.subAgentActivity) {
          const saPrefix = `agent/${sa.agentId}`
          const saText = sa.text.join("\n\n").trim()
          if (saText) {
            insert.run(sessionId, filePath, `${saPrefix}/assistantMessage`, saText)
          }
          const saThinking = sa.thinking
            .filter((t) => t.length > 0)
            .join("\n\n")
            .trim()
          if (saThinking) {
            insert.run(sessionId, filePath, `${saPrefix}/thinking`, saThinking)
          }
          for (const tc of sa.toolCalls) {
            const inputStr = JSON.stringify(tc.input)
            if (inputStr && inputStr !== "{}") {
              insert.run(sessionId, filePath, `${saPrefix}/toolCall/${tc.id}/input`, inputStr)
            }
            if (tc.result) {
              insert.run(sessionId, filePath, `${saPrefix}/toolCall/${tc.id}/result`, tc.result)
            }
          }
        }

        // Compaction summary
        if (turn.compactionSummary) {
          insert.run(sessionId, filePath, `${prefix}/compactionSummary`, turn.compactionSummary)
        }
      }

      // Track the file
      insertFile.run(filePath, mtimeMs, sessionId, isSubagent, parentSessionId)
    })

    txn()
    this._lastUpdate = new Date().toISOString()
  }

  /**
   * Query the FTS5 index and return structured search results.
   *
   * - FTS5 trigram tokenizer is case-insensitive by default.
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

    sql += " WHERE " + conditions.join(" AND ")
    sql += " LIMIT ?"
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      session_id: string
      location: string
      snippet: string
    }>

    let hits: SearchHit[] = rows.map((row) => ({
      sessionId: row.session_id,
      location: row.location,
      snippet: row.snippet,
      matchCount: 1, // FTS5 trigram doesn't expose per-row match count; 1 = "at least one match"
    }))

    // Post-filter for case sensitivity — FTS5 trigram is always case-insensitive,
    // so we apply an exact-case check on the snippet text when requested.
    if (caseSensitive) {
      hits = hits.filter((h) => h.snippet.includes(query))
    }

    return hits
  }

  /**
   * Clear all indexed data and re-index every JSONL file under `projectsDir`.
   * Structure: projectsDir/{projectName}/{sessionId}.jsonl
   * Subagents:  projectsDir/{projectName}/{sessionId}/subagents/agent-{id}.jsonl
   *
   * Stores `projectsDir` as a class field so `rebuild()` can reuse it.
   */
  buildFull(projectsDir: string): void {
    this.projectsDir = projectsDir

    // Clear everything
    this.db.exec("DELETE FROM search_content")
    this.db.exec("DELETE FROM indexed_files")

    this.indexProjectsDir(projectsDir)
    this._lastFullBuild = new Date().toISOString()
    this._lastUpdate = new Date().toISOString()
  }

  /**
   * Incrementally re-index only files whose mtime has changed since last index.
   * New files (not in indexed_files) are always indexed.
   */
  updateStale(projectsDir: string): void {
    this.projectsDir = projectsDir

    const getIndexed = this.db.prepare(
      "SELECT mtime_ms FROM indexed_files WHERE file_path = ?"
    )

    const filesToIndex: Array<{
      path: string
      sessionId: string
      mtimeMs: number
      isSubagent: boolean
      parentSessionId: string | null
    }> = []

    this.discoverFiles(projectsDir, (filePath, sessionId, mtimeMs, isSubagent, parentSessionId) => {
      const existing = getIndexed.get(filePath) as { mtime_ms: number } | undefined
      if (!existing || existing.mtime_ms < mtimeMs) {
        filesToIndex.push({ path: filePath, sessionId, mtimeMs, isSubagent, parentSessionId })
      }
    })

    for (const file of filesToIndex) {
      try {
        this.indexFile(file.path, file.sessionId, file.mtimeMs, {
          isSubagent: file.isSubagent,
          parentSessionId: file.parentSessionId,
        })
      } catch {
        // Skip files that fail to parse
      }
    }

    if (filesToIndex.length > 0) {
      this._lastUpdate = new Date().toISOString()
    }
  }

  /**
   * Re-run buildFull using the previously stored projectsDir.
   * No-op if projectsDir was never set.
   */
  rebuild(): void {
    if (!this.projectsDir) return
    this.buildFull(this.projectsDir)
  }

  /**
   * Walk all project directories under `projectsDir` and index every discovered
   * JSONL file (both sessions and subagents).
   */
  private indexProjectsDir(projectsDir: string): void {
    this.discoverFiles(projectsDir, (filePath, sessionId, mtimeMs, isSubagent, parentSessionId) => {
      try {
        this.indexFile(filePath, sessionId, mtimeMs, { isSubagent, parentSessionId })
      } catch {
        // Skip files that fail to parse
      }
    })
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
   */
  private discoverFiles(
    projectsDir: string,
    callback: (
      filePath: string,
      sessionId: string,
      mtimeMs: number,
      isSubagent: boolean,
      parentSessionId: string | null
    ) => void
  ): void {
    let entries: string[]
    try {
      entries = readdirSync(projectsDir)
    } catch {
      return
    }

    for (const projectName of entries) {
      if (projectName === "memory") continue
      const projectDir = join(projectsDir, projectName)
      try {
        const s = statSync(projectDir)
        if (!s.isDirectory()) continue
      } catch {
        continue
      }

      let files: string[]
      try {
        files = readdirSync(projectDir)
      } catch {
        continue
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue
        const filePath = join(projectDir, file)
        const sessionId = basename(file, ".jsonl")
        try {
          const s = statSync(filePath)
          callback(filePath, sessionId, s.mtimeMs, false, null)
        } catch {
          continue
        }

        // Discover subagent files recursively
        this.discoverSubagents(filePath, sessionId, callback, 0, 4)
      }
    }
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
  private discoverSubagents(
    parentPath: string,
    parentSessionId: string,
    callback: (
      filePath: string,
      sessionId: string,
      mtimeMs: number,
      isSubagent: boolean,
      parentSessionId: string | null
    ) => void,
    depth: number,
    maxDepth: number
  ): void {
    if (depth >= maxDepth) return

    // subagents dir lives at: parentPath minus .jsonl extension, plus /subagents
    const subDir = parentPath.replace(/\.jsonl$/, "") + "/subagents"
    let files: string[]
    try {
      files = readdirSync(subDir)
    } catch {
      return
    }

    for (const file of files) {
      if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) continue
      const filePath = join(subDir, file)
      try {
        const s = statSync(filePath)
        callback(filePath, parentSessionId, s.mtimeMs, true, parentSessionId)
      } catch {
        continue
      }

      // Recurse deeper for nested subagents
      this.discoverSubagents(filePath, parentSessionId, callback, depth + 1, maxDepth)
    }
  }

  close(): void {
    this.db.close()
  }
}
