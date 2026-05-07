import { join } from "node:path"
import { homedir } from "node:os"

/**
 * Resolve the canonical path for the search index database.
 *
 * Priority order:
 *   1. COGPIT_DATA_DIR env var (set by standalone server / CI)
 *   2. opts.userDataDir   (provided by Electron at runtime)
 *   3. ~/.claude/agent-window (dev fallback)
 */
export function resolveSearchIndexPath(opts?: { userDataDir?: string }): string {
  if (process.env.COGPIT_DATA_DIR) {
    return join(process.env.COGPIT_DATA_DIR, "search-index.db")
  }
  if (opts?.userDataDir) {
    return join(opts.userDataDir, "search-index.db")
  }
  return join(homedir(), ".claude", "agent-window", "search-index.db")
}
