// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
/**
 * The part of node:sqlite, bun:sqlite and better-sqlite3 the memory store
 * uses. Callers open the file with their own driver and pass the handle in.
 * Parameters are positional: the drivers disagree about bare named ones.
 */
export type SqlValue = string | number | bigint | null | Uint8Array

export interface SqlStatement {
  run(...params: SqlValue[]): unknown
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
}

export interface SqlDatabase {
  exec(sql: string): unknown
  prepare(sql: string): SqlStatement
  close(): unknown
}

/** How long a writer waits for another process's transaction. */
export const BUSY_TIMEOUT_MS = 10_000

export function configureConnection(db: SqlDatabase): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
}

/** One row or null, whichever driver answered (node and better-sqlite3 say undefined, bun says null). */
export function firstRow<T>(statement: SqlStatement, ...params: SqlValue[]): T | null {
  return (statement.get(...params) as T | null | undefined) ?? null
}

/** A write transaction that takes the lock up front, so two processes never deadlock upgrading a read lock. */
export function withTx<T>(db: SqlDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  let result: T
  try {
    result = fn()
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  db.exec("COMMIT")
  return result
}
