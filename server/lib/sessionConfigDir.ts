/**
 * `dirs.SESSION_CONFIG_DIR` keeps each session config as `<key>.json` beside
 * the files of other stores. Every such store declares its file here, so no
 * config key can name one of them.
 */

export const SESSION_ARCHIVE_FILE = "archived-sessions.json"
export const PR_SEARCH_INDEX_FILE = "pr-search-index.json"
export const SESSION_ORIGINS_FILE = "session-origins.json"
export const SESSION_BOARDS_FILE = "session-boards.json"
/** The parent-only record session origins replaced; its entries are a subset of an origin. */
export const LEGACY_SESSION_LINEAGE_FILE = "session-lineage.json"

const STORE_FILES: ReadonlySet<string> = new Set([
  SESSION_ARCHIVE_FILE,
  PR_SEARCH_INDEX_FILE,
  SESSION_ORIGINS_FILE,
  SESSION_BOARDS_FILE,
  LEGACY_SESSION_LINEAGE_FILE,
])

/** Whether a file in the directory belongs to a store, in any case a filesystem may fold to it. */
export function isStoreFile(fileName: string): boolean {
  return STORE_FILES.has(fileName.toLowerCase())
}
