import type { Dirent } from "node:fs"
import { dirs, readdir } from "../../helpers"

/**
 * Read Claude Code project directories without making them a prerequisite for
 * provider-neutral project/session views. A missing directory means Claude has
 * no local history; other I/O failures still surface to the caller.
 */
export async function readClaudeProjectEntries(): Promise<Dirent[]> {
  try {
    return await readdir(dirs.PROJECTS_DIR, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}
