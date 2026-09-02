import { getConfig, getDirs } from "./config"

/**
 * Directory references Cogpit derives from the active configuration.
 *
 * Mutable because the configured Claude directory can change at runtime, and
 * because `refreshDirs()` runs after config load rather than at import time.
 * Kept in its own module so the agent stores can read `PROJECTS_DIR` without
 * importing `sessionPaths`, which imports them back.
 */
export const dirs = {
  PROJECTS_DIR: "",
  TEAMS_DIR: "",
  TASKS_DIR: "",
  UNDO_DIR: "",
  SESSION_CONFIG_DIR: "",
}

export function refreshDirs(): boolean {
  const config = getConfig()
  if (!config) return false
  const configuredDirs = getDirs(config.claudeDir)
  dirs.PROJECTS_DIR = configuredDirs.PROJECTS_DIR
  dirs.TEAMS_DIR = configuredDirs.TEAMS_DIR
  dirs.TASKS_DIR = configuredDirs.TASKS_DIR
  dirs.UNDO_DIR = configuredDirs.UNDO_DIR
  dirs.SESSION_CONFIG_DIR = configuredDirs.SESSION_CONFIG_DIR
  return true
}
