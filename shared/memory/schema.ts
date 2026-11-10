// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
import { configureConnection, firstRow, withTx, type SqlDatabase } from "./database"

/** The store cannot be used here: no FTS5, or a schema newer than this code. */
export class MemoryStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "MemoryStoreUnavailableError"
  }
}

/**
 * One entry per schema version, applied in order inside one transaction.
 * Chunks are keyed by (file, turn, kind, block, part); `chunks_fts` reads its
 * text from `chunks`, kept current by triggers.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE source_files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    is_subagent INTEGER NOT NULL,
    parent_session_id TEXT,
    agent_id TEXT,
    mtime_ms REAL NOT NULL,
    size INTEGER NOT NULL,
    chunker_version INTEGER NOT NULL,
    inline_agents TEXT NOT NULL,
    synced_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT,
    source_file TEXT,
    first_at TEXT,
    last_at TEXT
  );
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES source_files(id),
    turn INTEGER NOT NULL,
    kind TEXT NOT NULL,
    block INTEGER NOT NULL,
    part INTEGER NOT NULL,
    turn_id TEXT,
    agent_id TEXT,
    inline_agent_id TEXT,
    session_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    cwd TEXT NOT NULL,
    timestamp TEXT,
    ts_ms INTEGER,
    automated INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    UNIQUE (file_id, turn, kind, block, part)
  );
  CREATE INDEX chunks_session ON chunks(session_id);
  CREATE INDEX chunks_text_hash ON chunks(text_hash);
  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text, content = 'chunks', content_rowid = 'id', tokenize = 'porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER chunks_after_insert AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER chunks_after_delete AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;
  CREATE TRIGGER chunks_after_text_update AFTER UPDATE OF text ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
  END;
  `,
  // Vectors are keyed by text, so identical chunks share one, and by model@dimensions, so a model change makes them pending.
  `
  CREATE TABLE vectors (
    text_hash TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    vector BLOB NOT NULL,
    norm REAL NOT NULL,
    PRIMARY KEY (text_hash, fingerprint)
  ) WITHOUT ROWID;
  `,
  // How long the last sync of a file took, so a search can skip one that is too slow for its budget.
  `
  ALTER TABLE source_files ADD COLUMN sync_ms INTEGER;
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length

function schemaVersion(db: SqlDatabase): number {
  return firstRow<{ user_version: number }>(db.prepare("PRAGMA user_version"))?.user_version ?? 0
}

/** Configure the connection and bring the schema up to date. Safe when another process does the same. */
export function prepareMemoryDatabase(db: SqlDatabase): void {
  try {
    configureConnection(db)
    if (schemaVersion(db) === SCHEMA_VERSION) return
    withTx(db, () => {
      const current = schemaVersion(db)
      if (current > SCHEMA_VERSION) {
        throw new MemoryStoreUnavailableError(`The memory store has schema ${current}; this build reads up to ${SCHEMA_VERSION}. Update Cogpit and cogpit-memory.`)
      }
      for (let version = current; version < SCHEMA_VERSION; version++) db.exec(MIGRATIONS[version]!)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
  } catch (error) {
    if (error instanceof MemoryStoreUnavailableError) throw error
    throw new MemoryStoreUnavailableError(`The memory store could not be opened: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
