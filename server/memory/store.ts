import { closeSync, mkdirSync, openSync, statSync } from "node:fs"
import type { SqlDatabase } from "../../shared/memory/database"
import { memoryDatabasePath } from "../../shared/memory/paths"
import { MemoryStore } from "../../shared/memory/store"
import { openDatabase } from "../orchestration/database"

/** Open the store in `dir`, creating it owner-only. Throws `MemoryStoreUnavailableError` when it cannot work here. */
export function openServerMemoryStore(dir: string): MemoryStore {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = memoryDatabasePath(dir)
  // SQLite gives the WAL and shared-memory files the database file's mode.
  closeSync(openSync(path, "a", 0o600))
  return MemoryStore.open(openDatabase(path) as SqlDatabase)
}

/** Archived means exactly this: the transcript's `stat` fails with ENOENT. */
export function transcriptExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== "ENOENT" && code !== "ENOTDIR"
  }
}
