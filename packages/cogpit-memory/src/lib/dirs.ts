import { join } from "node:path"
import { homedir } from "node:os"
import { descriptorFor, type AgentKind } from "./agent-descriptors"

/**
 * Where each agent CLI keeps its state, honouring the environment variable it
 * publishes for that. `$CODEX_HOME` used to be ignored here while
 * `$COPILOT_HOME` was honoured, so a redirected Codex install was invisible to
 * the whole package.
 */
export function agentHomeDir(
  kind: AgentKind,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const { homeEnvVar, homeDirName } = descriptorFor(kind).cli
  const override = homeEnvVar ? env[homeEnvVar] : undefined
  return override || join(homeDirectory, homeDirName)
}

export const dirs = {
  PROJECTS_DIR: join(agentHomeDir("claude"), "projects"),
  TEAMS_DIR: join(agentHomeDir("claude"), "teams"),
  TASKS_DIR: join(agentHomeDir("claude"), "tasks"),
  CODEX_SESSIONS_DIR: join(agentHomeDir("codex"), "sessions"),
  COPILOT_SESSIONS_DIR: join(agentHomeDir("copilot"), "session-state"),
}

/** Default database path for the FTS5 search index. */
export const DEFAULT_DB_PATH = join(agentHomeDir("claude"), "cogpit-memory", "search-index.db")
