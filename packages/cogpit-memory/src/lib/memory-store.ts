/**
 * Opening the shared memory store from the CLI: the path resolver, owner-only
 * permissions, and the `stat` that decides whether a hit is archived.
 */
import { closeSync, mkdirSync, openSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { Database } from "bun:sqlite"
import { memoryDatabasePath, resolveMemoryDir } from "./memory/paths"
import { MemoryStore } from "./memory/store"

export function memoryDir(): string {
  return resolveMemoryDir(process.env, homedir())
}

/** Open, creating it owner-only when missing. Throws `MemoryStoreUnavailableError` when it cannot work here. */
export function openMemoryStore(dir = memoryDir()): MemoryStore {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = memoryDatabasePath(dir)
  // SQLite gives the WAL and shared-memory files the database file's mode.
  closeSync(openSync(path, "a", 0o600))
  return MemoryStore.open(new Database(path))
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
