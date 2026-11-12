// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
/**
 * The durable prose store. A sync replaces what a transcript's re-parse no
 * longer contains, but nothing is removed because a transcript disappeared:
 * its chunks stay, reported as archived.
 */
import type { ParsedSession } from "../types"
import { CHUNKER_VERSION, chunkSession, type ChunkOptions } from "./chunker"
import { firstRow, withTx, type SqlDatabase, type SqlValue } from "./database"
import { textHash } from "./hash"
import { prepareMemoryDatabase, SCHEMA_VERSION } from "./schema"
import type { Chunk, ChunkKind, SourceFile } from "./types"

export interface SyncedFile {
  mtimeMs: number
  size: number
  chunkerVersion: number
  /** Subagents whose text came from this transcript's inline reports, having no transcript of their own then. */
  inlineAgents: string[]
  /** When it was last synced (epoch ms). */
  syncedAtMs: number
  /** How long that sync took; null when unknown. */
  syncMs: number | null
}

export interface SyncSessionOptions extends ChunkOptions {
  /** Session title to snapshot; the first typed prompt when absent. */
  title?: string | null
  now?: number
  /** Time already spent on this file before the call (reading, parsing, other indexes); the recorded sync duration adds the call's own. */
  elapsedMs?: number
}

export interface SyncResult {
  added: number
  updated: number
  removed: number
  kept: number
  /** Another writer already stored a newer state of this file; nothing was written. */
  superseded: boolean
}

export interface MemoryStatus {
  schemaVersion: number
  chunkerVersion: number
  sourceFiles: number
  sessions: number
  chunks: number
  chunksByKind: Partial<Record<ChunkKind, number>>
  automatedChunks: number
  textBytes: number
  oldestChunkAt: string | null
  newestChunkAt: string | null
  lastSyncAt: string | null
  /** Source files whose transcript is gone; only when the caller can stat files. */
  archivedFiles?: number
  /** Vector coverage for one model@dimensions; only when a fingerprint is passed. */
  embeddings?: EmbeddingCounts
}

interface StoredChunk {
  id: number
  turn: number
  kind: ChunkKind
  block: number
  part: number
  text_hash: string
  signature: string
}

const TITLE_CHARS = 120

export class MemoryStore {
  private constructor(readonly db: SqlDatabase) {}

  /** Configure and migrate `db`. Throws `MemoryStoreUnavailableError` when the store cannot work here. */
  static open(db: SqlDatabase): MemoryStore {
    prepareMemoryDatabase(db)
    return new MemoryStore(db)
  }

  close(): void {
    this.db.close()
  }

  syncedFiles(): Map<string, SyncedFile> {
    const rows = this.db.prepare("SELECT path, mtime_ms, size, chunker_version, inline_agents, synced_at, sync_ms FROM source_files").all() as Array<{
      path: string
      mtime_ms: number
      size: number
      chunker_version: number
      inline_agents: string
      synced_at: number
      sync_ms: number | null
    }>
    return new Map(rows.map((row) => [row.path, {
      mtimeMs: row.mtime_ms,
      size: row.size,
      chunkerVersion: row.chunker_version,
      inlineAgents: row.inline_agents ? row.inline_agents.split(" ") : [],
      syncedAtMs: row.synced_at,
      syncMs: row.sync_ms,
    }]))
  }

  /**
   * The files whose stored chunks are stale or missing, newest first. `files`
   * is the whole walk: a parent whose inline subagent has since gained its own
   * transcript is stale too, so that text is not indexed twice.
   */
  planSync(files: readonly SourceFile[], synced = this.syncedFiles()): SourceFile[] {
    const hasTranscript = subagentTranscripts(files)
    return files
      .filter((file) => {
        const state = synced.get(file.path)
        return !state || isStale(file, state) || state.inlineAgents.some(hasTranscript(file.sessionId))
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  /** Make the stored chunks of `file` match `session`, its fresh parse. */
  syncSession(file: SourceFile, session: ParsedSession, options: SyncSessionOptions = {}): SyncResult {
    const started = Date.now()
    const chunks = chunkSession(session, options)
    const cwd = session.cwd || ""
    const now = options.now ?? Date.now()
    const inlineAgents = [...new Set(chunks.flatMap((chunk) => chunk.inlineAgentId ?? []))].sort()
    const result: SyncResult = { added: 0, updated: 0, removed: 0, kept: 0, superseded: false }
    withTx(this.db, () => {
      // Two writers may parse the same file; the one holding an older state must not undo the newer one.
      const current = firstRow<{ mtime_ms: number; size: number; chunker_version: number }>(
        this.db.prepare("SELECT mtime_ms, size, chunker_version FROM source_files WHERE path = ?"), file.path)
      if (current && (current.chunker_version > CHUNKER_VERSION || current.mtime_ms > file.mtimeMs
        || (current.mtime_ms === file.mtimeMs && current.size > file.size))) {
        result.superseded = true
        return
      }
      const fileId = this.upsertSourceFile(file, inlineAgents, now)
      const stored = new Map<string, StoredChunk>()
      const rows = this.db.prepare(`SELECT id, turn, kind, block, part, text_hash, ${SIGNATURE_SQL} AS signature FROM chunks WHERE file_id = ?`).all(fileId) as StoredChunk[]
      for (const row of rows) stored.set(chunkKey(row), row)

      const insert = this.db.prepare(`INSERT INTO chunks (file_id, turn, kind, block, part, ${CHUNK_COLUMNS.join(", ")}, text, text_hash)
        VALUES (?, ?, ?, ?, ?, ${CHUNK_COLUMNS.map(() => "?").join(", ")}, ?, ?)`)
      const updateText = this.db.prepare(`UPDATE chunks SET ${CHUNK_COLUMNS.map((column) => `${column} = ?`).join(", ")}, text = ?, text_hash = ? WHERE id = ?`)
      const updateMeta = this.db.prepare(`UPDATE chunks SET ${CHUNK_COLUMNS.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`)
      const remove = this.db.prepare("DELETE FROM chunks WHERE id = ?")

      for (const chunk of chunks) {
        const values = chunkValues(chunk, file, cwd)
        const hash = textHash(chunk.text)
        const key = chunkKey(chunk)
        const existing = stored.get(key)
        if (!existing) {
          insert.run(fileId, chunk.turn, chunk.kind, chunk.block, chunk.part, ...values, chunk.text, hash)
          result.added++
          continue
        }
        stored.delete(key)
        if (existing.text_hash !== hash) {
          updateText.run(...values, chunk.text, hash, existing.id)
          result.updated++
        } else {
          if (existing.signature !== signatureOf(values)) updateMeta.run(...values, existing.id)
          result.kept++
        }
      }
      for (const row of stored.values()) {
        remove.run(row.id)
        result.removed++
      }
      this.upsertSession(file, session, cwd, chunks, options.title)
      this.db.prepare("UPDATE source_files SET sync_ms = ? WHERE id = ?").run((options.elapsedMs ?? 0) + Date.now() - started, fileId)
    })
    return result
  }

  status(options: { fileExists?: (path: string) => boolean; fingerprint?: string } = {}): MemoryStatus {
    const count = (sql: string) => firstRow<{ n: number | null }>(this.db.prepare(sql))?.n ?? 0
    const kinds = this.db.prepare("SELECT kind, COUNT(*) AS n FROM chunks GROUP BY kind").all() as Array<{ kind: ChunkKind; n: number }>
    const range = firstRow<{ oldest: string | null; newest: string | null }>(
      this.db.prepare("SELECT MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM chunks"),
    )
    const lastSync = count("SELECT MAX(synced_at) AS n FROM source_files")
    const status: MemoryStatus = {
      schemaVersion: SCHEMA_VERSION,
      chunkerVersion: CHUNKER_VERSION,
      sourceFiles: count("SELECT COUNT(*) AS n FROM source_files"),
      sessions: count("SELECT COUNT(*) AS n FROM sessions"),
      chunks: kinds.reduce((total, row) => total + row.n, 0),
      chunksByKind: Object.fromEntries(kinds.map((row) => [row.kind, row.n])),
      automatedChunks: count("SELECT COUNT(*) AS n FROM chunks WHERE automated = 1"),
      textBytes: count("SELECT SUM(LENGTH(CAST(text AS BLOB))) AS n FROM chunks"),
      oldestChunkAt: range?.oldest ?? null,
      newestChunkAt: range?.newest ?? null,
      lastSyncAt: lastSync ? new Date(lastSync).toISOString() : null,
    }
    if (options.fileExists) {
      const paths = this.db.prepare("SELECT path FROM source_files").all() as Array<{ path: string }>
      status.archivedFiles = paths.filter(({ path }) => !options.fileExists!(path)).length
    }
    if (options.fingerprint) status.embeddings = embeddingCounts(this, options.fingerprint)
    return status
  }

  private upsertSourceFile(file: SourceFile, inlineAgents: readonly string[], now: number): number {
    const row = firstRow<{ id: number }>(this.db.prepare(`
      INSERT INTO source_files (path, session_id, instance_id, agent_kind, is_subagent, parent_session_id, agent_id, mtime_ms, size, chunker_version, inline_agents, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (path) DO UPDATE SET
        session_id = excluded.session_id, instance_id = excluded.instance_id, agent_kind = excluded.agent_kind,
        is_subagent = excluded.is_subagent, parent_session_id = excluded.parent_session_id, agent_id = excluded.agent_id,
        mtime_ms = excluded.mtime_ms, size = excluded.size, chunker_version = excluded.chunker_version,
        inline_agents = excluded.inline_agents, synced_at = excluded.synced_at
      RETURNING id`),
    file.path, file.sessionId, file.instanceId, file.agentKind, file.isSubagent ? 1 : 0, file.parentSessionId, file.agentId,
    file.mtimeMs, file.size, CHUNKER_VERSION, inlineAgents.join(" "), now)
    if (!row) throw new Error(`Recording ${file.path} in the memory store returned no id`)
    return row.id
  }

  private upsertSession(file: SourceFile, session: ParsedSession, cwd: string, chunks: readonly Chunk[], title: string | null | undefined): void {
    const timestamps = chunks.map((chunk) => chunk.timestamp).filter((value): value is string => !!value).sort()
    const values: SqlValue[] = [file.sessionId, file.instanceId, file.agentKind, cwd]
    if (file.isSubagent) {
      // A subagent's transcript can be synced before its parent's; the parent fills the rest in.
      this.db.prepare(`INSERT INTO sessions (session_id, instance_id, agent_kind, cwd) VALUES (?, ?, ?, ?)
        ON CONFLICT (session_id) DO NOTHING`).run(...values)
      return
    }
    // A given title replaces the snapshot; a title guessed from the first prompt only fills a gap.
    const given = title?.trim() || session.name || null
    this.db.prepare(`
      INSERT INTO sessions (session_id, instance_id, agent_kind, cwd, title, source_file, first_at, last_at)
      VALUES (?, ?, ?, ?, COALESCE(?, ?), ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        instance_id = excluded.instance_id, agent_kind = excluded.agent_kind, cwd = excluded.cwd,
        title = COALESCE(?, sessions.title, excluded.title), source_file = excluded.source_file,
        first_at = COALESCE(excluded.first_at, sessions.first_at), last_at = COALESCE(excluded.last_at, sessions.last_at)`)
      .run(...values, given, firstPromptTitle(chunks), file.path, timestamps[0] ?? null, timestamps.at(-1) ?? null, given)
  }
}

export interface EmbeddingCounts {
  fingerprint: string
  /** Chunks with a vector for this fingerprint. */
  embedded: number
  pending: number
}

/** True for a chunk `c` without a vector for the fingerprint bound to its `?`. */
export const MISSING_VECTOR = "NOT EXISTS (SELECT 1 FROM vectors v WHERE v.text_hash = c.text_hash AND v.fingerprint = ?)"

export function embeddingCounts(store: MemoryStore, fingerprint: string): EmbeddingCounts {
  const total = firstRow<{ n: number }>(store.db.prepare("SELECT COUNT(*) AS n FROM chunks"))?.n ?? 0
  const pending = firstRow<{ n: number }>(store.db.prepare(`SELECT COUNT(*) AS n FROM chunks c WHERE ${MISSING_VECTOR}`), fingerprint)?.n ?? 0
  return { fingerprint, embedded: total - pending, pending }
}

/** Which subagents have a transcript of their own, from the same walk, keyed by parent session. */
export function subagentTranscripts(files: readonly SourceFile[]): (sessionId: string) => (agentId: string) => boolean {
  const bySession = new Map<string, Set<string>>()
  for (const file of files) {
    if (!file.isSubagent || !file.agentId) continue
    let agents = bySession.get(file.sessionId)
    if (!agents) bySession.set(file.sessionId, agents = new Set())
    agents.add(file.agentId)
  }
  return (sessionId) => (agentId) => bySession.get(sessionId)?.has(agentId) ?? false
}

function isStale(file: SourceFile, synced: SyncedFile | undefined): boolean {
  return !synced || synced.mtimeMs !== file.mtimeMs || synced.size !== file.size || synced.chunkerVersion < CHUNKER_VERSION
}

function chunkKey(chunk: Pick<Chunk, "turn" | "kind" | "block" | "part">): string {
  return `${chunk.turn}:${chunk.kind}:${chunk.block}:${chunk.part}`
}

/** Columns a re-parse may change without changing the text. */
const CHUNK_COLUMNS = ["turn_id", "agent_id", "inline_agent_id", "session_id", "instance_id", "agent_kind", "cwd", "timestamp", "ts_ms", "automated"] as const
const SIGNATURE_SQL = CHUNK_COLUMNS.map((column) => `COALESCE(${column}, '')`).join(" || char(31) || ")

function chunkValues(chunk: Chunk, file: SourceFile, cwd: string): SqlValue[] {
  const timestampMs = chunk.timestamp ? Date.parse(chunk.timestamp) : NaN
  return [
    chunk.turnId,
    file.agentId,
    chunk.inlineAgentId,
    file.sessionId,
    file.instanceId,
    file.agentKind,
    cwd,
    chunk.timestamp,
    Number.isFinite(timestampMs) ? timestampMs : null,
    chunk.automated ? 1 : 0,
  ]
}

function signatureOf(values: readonly SqlValue[]): string {
  return values.map((value) => (value === null ? "" : String(value))).join("\u001f")
}

function firstPromptTitle(chunks: readonly Chunk[]): string | null {
  const prompt = chunks.find((chunk) => chunk.kind === "user" && !chunk.automated)
  const line = prompt?.text.split("\n").find((text) => text.trim())?.trim()
  return line ? line.slice(0, TITLE_CHARS) : null
}
