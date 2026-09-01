/**
 * Session source utilities — thin re-exports and wrappers over src/lib/providers.
 * All implementations live in the provider modules; this file exists for
 * backwards compatibility and as a convenience import for client code.
 */
import type { AgentKind } from "./providers/types"
import { getProvider, inferAgentKind } from "./providers/registry"
import { encodeCodexDirName, isCodexDirName } from "./providers/codex"
import { encodeCopilotDirName, isCopilotDirName } from "./providers/copilot"
import { encodeClaudeDirName } from "./providers/claude"

export type { AgentKind } from "./providers/types"
export { isCodexDirName, encodeCodexDirName } from "./providers/codex"
export { isCopilotDirName, encodeCopilotDirName } from "./providers/copilot"
export { encodeClaudeDirName } from "./providers/claude"
export { inferAgentKind as inferSessionSourceKind, inferAgentKind as agentKindFromDirName } from "./providers/registry"

const FILE_UUID_RE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/
const COPILOT_SESSION_FILE_RE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/events\.jsonl$/

/**
 * Derive a session id from a session fileName when the parsed id is missing.
 * Claude files are `<uuid>.jsonl`; Copilot files are
 * `<uuid>/events.jsonl`; Codex rollouts are nested
 * `YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` paths, so the embedded UUID
 * must be extracted — the raw path is never a valid session/thread id.
 */
export function sessionIdFromFileName(fileName: string): string {
  const copilotMatch = COPILOT_SESSION_FILE_RE.exec(fileName)
  if (copilotMatch) return copilotMatch[1]
  const match = FILE_UUID_RE.exec(fileName)
  return match ? match[1] : fileName.replace(".jsonl", "")
}

/** Preserve provider file identity in URLs while keeping Copilot links short. */
export function sessionUrlIdFromFileName(dirName: string, fileName: string): string {
  return isCopilotDirName(dirName)
    ? sessionIdFromFileName(fileName)
    : fileName.replace(/\.jsonl$/, "")
}

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
  if (agentKind === "codex") return encodeCodexDirName(cwd)
  if (agentKind === "copilot") return encodeCopilotDirName(cwd)
  return claudeDirName
}

export function projectDirNameForNewFolder(cwd: string, agentKind: AgentKind): string {
  if (agentKind === "codex") return encodeCodexDirName(cwd)
  if (agentKind === "copilot") return encodeCopilotDirName(cwd)
  return encodeClaudeDirName(cwd)
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
    !isCopilotDirName(project.dirName) &&
    normalizeProjectPath(project.path) === normalizedCwd
  )?.dirName ?? null
}

// Re-export inferAgentKind as the canonical name for server-side callers
export { inferAgentKind }
