/**
 * The library's own SQLite store: every time a reply shared something, as an
 * occurrence row, and the copies it keeps of local files. It is fed from the
 * memory store (`sync.ts`) and never forgets an occurrence because its
 * transcript changed or went away; a person removes one by hand.
 */
import { configureConnection, firstRow, withTx, type SqlDatabase, type SqlValue } from "../../shared/memory/database"
import type { LibraryItemKind, LibraryKeepState } from "../../shared/library/types"

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    occurrence TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    source_file TEXT NOT NULL,
    cwd TEXT NOT NULL,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    label TEXT,
    turn INTEGER NOT NULL,
    turn_id TEXT,
    shared_at TEXT,
    shared_ms INTEGER,
    kept TEXT,
    keep_state TEXT,
    removed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX items_session ON items(session_id);
  CREATE INDEX items_project ON items(project);
  CREATE INDEX items_keep ON items(keep_state, kind);
  CREATE TABLE files (
    hash TEXT PRIMARY KEY,
    ext TEXT NOT NULL,
    size INTEGER NOT NULL,
    kept_at INTEGER NOT NULL
  );
  CREATE TABLE sources (
    path TEXT PRIMARY KEY,
    synced_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT,
    cwd TEXT NOT NULL
  );
  `,
]

export class LibraryStoreUnavailableError extends Error {}

/** One time a reply shared something. */
export interface Occurrence {
  sessionId: string
  sourceFile: string
  cwd: string
  project: string
  kind: LibraryItemKind
  target: string
  label: string | null
  turn: number
  turnId: string | null
  sharedAt: string | null
  sharedMs: number | null
}

export interface ItemRow {
  id: number
  session_id: string
  source_file: string
  project: string
  kind: LibraryItemKind
  target: string
  label: string | null
  turn: number
  turn_id: string | null
  shared_at: string | null
  shared_ms: number | null
  kept: string | null
  keep_state: LibraryKeepState | null
  ext: string | null
}

/** A local file the library has yet to look at. */
export interface PendingKeep {
  id: number
  kind: "image" | "video" | "file"
  target: string
  sharedMs: number | null
}

export interface KeptFile {
  hash: string
  ext: string
  size: number
}

export interface SessionRow {
  session_id: string
  title: string | null
  cwd: string
}

export type ItemScope = { sessionId: string } | { project: string } | null

const ITEM_COLUMNS = "i.id, i.session_id, i.source_file, i.project, i.kind, i.target, i.label, i.turn, i.turn_id, i.shared_at, i.shared_ms, i.kept, i.keep_state, f.ext"
const ITEMS_WITH_FILES = "items i LEFT JOIN files f ON f.hash = i.kept"
const KEEPABLE_KINDS = "('image', 'video', 'file')"

/** Two mentions are one occurrence when they share a turn; the same path shared in another turn may be another file. */
function occurrenceKey(occurrence: Occurrence): string {
  return [occurrence.sessionId, occurrence.kind, occurrence.target, occurrence.turnId ?? `#${occurrence.turn}`].join("\u001f")
}

function sameItemMatch(row: ItemRow): [condition: string, value: string] {
  if (row.kind === "link" || row.kind === "view") return ["i.target = ?", row.target]
  if (row.kept) return ["i.kept = ?", row.kept]
  return ["i.target = ? AND i.kept IS NULL", row.target]
}

export class LibraryStore {
  private constructor(readonly db: SqlDatabase) {}

  /** Configure and migrate `db`; throws `LibraryStoreUnavailableError` when it cannot work. */
  static open(db: SqlDatabase): LibraryStore {
    try {
      configureConnection(db)
      const version = firstRow<{ user_version: number }>(db.prepare("PRAGMA user_version"))?.user_version ?? 0
      if (version > MIGRATIONS.length) throw new LibraryStoreUnavailableError(`The library store has schema ${version}; this build reads up to ${MIGRATIONS.length}. Update Cogpit.`)
      if (version < MIGRATIONS.length) {
        withTx(db, () => {
          for (let next = version; next < MIGRATIONS.length; next++) db.exec(MIGRATIONS[next]!)
          db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
        })
      }
    } catch (error) {
      if (error instanceof LibraryStoreUnavailableError) throw error
      throw new LibraryStoreUnavailableError(`The library store could not be opened: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return new LibraryStore(db)
  }

  close(): void {
    this.db.close()
  }

  /** The memory store's sync time of each transcript already read. */
  sourceStates(): Map<string, number> {
    const rows = this.db.prepare("SELECT path, synced_at FROM sources").all() as Array<{ path: string; synced_at: number }>
    return new Map(rows.map((row) => [row.path, row.synced_at]))
  }

  /**
   * Records what transcripts shared as of their sync time, in one step. An
   * occurrence seen again takes the newer reading; one no longer in its
   * transcript stays, as does anything removed by hand.
   */
  record(sources: ReadonlyArray<{ path: string; syncedAt: number }>, occurrences: readonly Occurrence[], sessions: readonly SessionRow[]): void {
    withTx(this.db, () => {
      const upsert = this.db.prepare(`
        INSERT INTO items (occurrence, session_id, source_file, cwd, project, kind, target, label, turn, turn_id, shared_at, shared_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (occurrence) DO UPDATE SET
          source_file = excluded.source_file, cwd = excluded.cwd, project = excluded.project,
          label = COALESCE(excluded.label, items.label), turn = excluded.turn,
          shared_at = COALESCE(excluded.shared_at, items.shared_at), shared_ms = COALESCE(excluded.shared_ms, items.shared_ms)`)
      for (const occurrence of occurrences) {
        upsert.run(occurrenceKey(occurrence), occurrence.sessionId, occurrence.sourceFile, occurrence.cwd, occurrence.project, occurrence.kind,
          occurrence.target, occurrence.label, occurrence.turn, occurrence.turnId, occurrence.sharedAt, occurrence.sharedMs)
      }
      const session = this.db.prepare(`INSERT INTO sessions (session_id, title, cwd) VALUES (?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET title = COALESCE(excluded.title, sessions.title), cwd = excluded.cwd`)
      for (const row of sessions) session.run(row.session_id, row.title, row.cwd)
      const source = this.db.prepare("INSERT INTO sources (path, synced_at) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET synced_at = excluded.synced_at")
      for (const { path, syncedAt } of sources) source.run(path, syncedAt)
    })
  }

  /** Local files not yet looked at, newest first. */
  pendingKeeps(limit: number): PendingKeep[] {
    const rows = this.db.prepare(`SELECT id, kind, target, shared_ms FROM items WHERE keep_state IS NULL AND removed = 0 AND kind IN ${KEEPABLE_KINDS}
      ORDER BY COALESCE(shared_ms, 0) DESC, id DESC LIMIT ?`).all(limit) as Array<{ id: number; kind: PendingKeep["kind"]; target: string; shared_ms: number | null }>
    return rows.map((row) => ({ id: row.id, kind: row.kind, target: row.target, sharedMs: row.shared_ms }))
  }

  setKeepState(id: number, state: Exclude<LibraryKeepState, "kept">): void {
    this.db.prepare("UPDATE items SET keep_state = ?, kept = NULL WHERE id = ?").run(state, id)
  }

  /** Files the library kept, by hash. */
  keptFile(hash: string): KeptFile | null {
    return firstRow<KeptFile>(this.db.prepare("SELECT hash, ext, size FROM files WHERE hash = ?"), hash)
  }

  /** Points an occurrence at a kept copy, recording the copy when it is new. */
  keep(id: number, file: KeptFile, now = Date.now()): void {
    withTx(this.db, () => {
      this.db.prepare("INSERT INTO files (hash, ext, size, kept_at) VALUES (?, ?, ?, ?) ON CONFLICT (hash) DO NOTHING").run(file.hash, file.ext, file.size, now)
      this.db.prepare("UPDATE items SET kept = ?, keep_state = 'kept' WHERE id = ?").run(file.hash, id)
    })
  }

  keptBytes(): number {
    return firstRow<{ n: number | null }>(this.db.prepare("SELECT SUM(size) AS n FROM files"))?.n ?? 0
  }

  /** Kept copies, the one whose newest occurrence is oldest first, with that time. */
  keptByAge(): Array<KeptFile & { newestMs: number }> {
    return this.db.prepare(`SELECT f.hash, f.ext, f.size, COALESCE(MAX(i.shared_ms), 0) AS newestMs
      FROM files f LEFT JOIN items i ON i.kept = f.hash AND i.removed = 0
      GROUP BY f.hash ORDER BY newestMs ASC, f.kept_at ASC`).all() as Array<KeptFile & { newestMs: number }>
  }

  /** Forgets a kept copy to make room: its occurrences fall back to the original path. The caller deletes the file. */
  dropKept(hash: string): void {
    withTx(this.db, () => {
      this.db.prepare("UPDATE items SET kept = NULL, keep_state = 'evicted' WHERE kept = ?").run(hash)
      this.db.prepare("DELETE FROM files WHERE hash = ?").run(hash)
    })
  }

  /** Every occurrence still listed in the scope, newest first, up to `limit`. */
  items(scope: ItemScope, limit: number): ItemRow[] {
    const where: string[] = ["i.removed = 0"]
    const params: SqlValue[] = []
    if (scope && "sessionId" in scope) {
      where.push("i.session_id = ?")
      params.push(scope.sessionId)
    } else if (scope) {
      where.push("i.project = ?")
      params.push(scope.project)
    }
    return this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM ${ITEMS_WITH_FILES}
      WHERE ${where.join(" AND ")} ORDER BY COALESCE(i.shared_ms, 0) DESC, i.id DESC LIMIT ?`).all(...params, limit) as ItemRow[]
  }

  /** An occurrence, removed or not. */
  item(id: number): (ItemRow & { removed: number }) | null {
    return firstRow<ItemRow & { removed: number }>(this.db.prepare(`SELECT ${ITEM_COLUMNS}, i.removed FROM ${ITEMS_WITH_FILES} WHERE i.id = ?`), id)
  }

  /** The other listed occurrences an item stands for: the same link or view, or the same file content (or path, without a copy). */
  duplicates(row: ItemRow): ItemRow[] {
    const [sameItem, value] = sameItemMatch(row)
    return this.db.prepare(`SELECT ${ITEM_COLUMNS} FROM ${ITEMS_WITH_FILES}
      WHERE i.removed = 0 AND i.kind = ? AND ${sameItem}`).all(row.kind, value) as ItemRow[]
  }

  /** Takes occurrences out of the library for good; answers the kept copies nothing lists any more, for the caller to delete. */
  remove(ids: readonly number[]): KeptFile[] {
    return withTx(this.db, () => {
      const hide = this.db.prepare("UPDATE items SET removed = 1 WHERE id = ?")
      for (const id of ids) hide.run(id)
      const orphans = this.db.prepare(`SELECT f.hash, f.ext, f.size FROM files f
        WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.kept = f.hash AND i.removed = 0)`).all() as KeptFile[]
      const forget = this.db.prepare("DELETE FROM files WHERE hash = ?")
      const unlink = this.db.prepare("UPDATE items SET kept = NULL WHERE kept = ?")
      for (const orphan of orphans) {
        unlink.run(orphan.hash)
        forget.run(orphan.hash)
      }
      return orphans
    })
  }

  sessions(ids: readonly string[]): SessionRow[] {
    const rows: SessionRow[] = []
    for (let start = 0; start < ids.length; start += 500) {
      const batch = ids.slice(start, start + 500)
      rows.push(...this.db.prepare(`SELECT session_id, title, cwd FROM sessions WHERE session_id IN (${batch.map(() => "?").join(", ")})`).all(...batch) as SessionRow[])
    }
    return rows
  }
}
