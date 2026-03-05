import Database from "better-sqlite3"
import { readFileSync, statSync } from "node:fs"
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

export class SearchIndex {
  private db: InstanceType<typeof Database>
  private dbPath: string
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

  close(): void {
    this.db.close()
  }
}
