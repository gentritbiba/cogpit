/**
 * Index command — stats and rebuild for the FTS5 search index.
 *
 * Two entry points:
 *   indexStats(dbPath?)   — returns IndexStats or error if DB doesn't exist
 *   indexRebuild(dbPath?) — creates/rebuilds the FTS5 index, returns stats
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { SearchIndex, type IndexStats } from "../lib/search-index"
import { DEFAULT_DB_PATH, dirs } from "../lib/dirs"

export async function indexStats(dbPath?: string): Promise<IndexStats | { error: string }> {
  const path = dbPath ?? DEFAULT_DB_PATH
  if (!existsSync(path)) {
    return { error: `Database not found at ${path}. Run 'cogpit-memory index rebuild' to create it.` }
  }
  const index = new SearchIndex(path)
  const stats = index.getStats()
  index.close()
  return stats
}

export async function indexRebuild(dbPath?: string): Promise<{ status: string; stats: IndexStats }> {
  const path = dbPath ?? DEFAULT_DB_PATH
  mkdirSync(dirname(path), { recursive: true })
  const index = new SearchIndex(path)
  index.buildFull(dirs.PROJECTS_DIR)
  const stats = index.getStats()
  index.close()
  return { status: "rebuilt", stats }
}
