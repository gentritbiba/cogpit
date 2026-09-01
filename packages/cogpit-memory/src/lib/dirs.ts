import { join } from "node:path"
import { homedir } from "node:os"

export function copilotSessionsDir(
  copilotHome = process.env.COPILOT_HOME,
  homeDirectory = homedir(),
): string {
  return join(copilotHome || join(homeDirectory, ".copilot"), "session-state")
}

export const dirs = {
  PROJECTS_DIR: join(homedir(), ".claude", "projects"),
  TEAMS_DIR: join(homedir(), ".claude", "teams"),
  TASKS_DIR: join(homedir(), ".claude", "tasks"),
  CODEX_SESSIONS_DIR: join(homedir(), ".codex", "sessions"),
  COPILOT_SESSIONS_DIR: copilotSessionsDir(),
}

/** Default database path for the FTS5 search index. */
export const DEFAULT_DB_PATH = join(homedir(), ".claude", "cogpit-memory", "search-index.db")
