import { createRequire } from "node:module"
import type { DatabaseSync } from "node:sqlite"

export type SqliteDatabase = Pick<DatabaseSync, "exec" | "prepare" | "close">
const require = createRequire(import.meta.url)

export function openDatabase(path: string): SqliteDatabase {
  const Database = (process.versions.bun ? require("bun:sqlite").Database : require("node:sqlite").DatabaseSync) as new (path: string) => SqliteDatabase
  return new Database(path)
}
