// Node.js shim: re-export better-sqlite3 as a named "Database" export
// to match bun:sqlite's API shape. Used only during npm build via esbuild --alias.
import BetterSqlite3 from "better-sqlite3"
export const Database = BetterSqlite3
