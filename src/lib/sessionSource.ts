/**
 * Session source utilities — thin re-exports and wrappers over src/lib/providers.
 * All implementations live in the provider modules; this file exists for
 * backwards compatibility and as a convenience import for client code.
 */
import type { AgentKind } from "./providers/types"
import { getProvider, inferAgentKind } from "./providers/registry"
import { encodeCodexDirName, isCodexDirName } from "./providers/codex"

export type { AgentKind } from "./providers/types"
export { isCodexDirName, encodeCodexDirName } from "./providers/codex"
export { inferAgentKind as inferSessionSourceKind, inferAgentKind as agentKindFromDirName } from "./providers/registry"

/** @deprecated Alias for AgentKind — use AgentKind directly */
export type SessionSourceKind = AgentKind

export function getResumeCommand(
  agentKind: AgentKind,
  sessionId: string,
  cwd?: string,
): string {
  return getProvider(agentKind).resumeCommand(sessionId, cwd)
}

/**
 * Resolve the provider-specific dirName for a project when the Claude-style
 * project directory name is known.
 */
export function projectDirNameForAgent(
  claudeDirName: string,
  cwd: string,
  agentKind: AgentKind,
): string {
  return agentKind === "codex" ? encodeCodexDirName(cwd) : claudeDirName
}

interface ProjectDirEntry {
  dirName: string
  path: string
}

function normalizeProjectPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  return trimmed || "/"
}

export function findClaudeProjectDirNameForCwd(
  projects: readonly ProjectDirEntry[],
  cwd: string,
): string | null {
  const normalizedCwd = normalizeProjectPath(cwd)
  return projects.find((project) =>
    !isCodexDirName(project.dirName) &&
    normalizeProjectPath(project.path) === normalizedCwd
  )?.dirName ?? null
}

// Re-export inferAgentKind as the canonical name for server-side callers
export { inferAgentKind }
