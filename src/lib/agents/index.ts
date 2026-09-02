/**
 * The renderer's view of the agent registry.
 *
 * Everything an agent *is* — dirName codecs, session-file naming, resume argv,
 * capability flags — comes from `shared/session/agent-descriptors`, which the
 * server and the cogpit-memory package read too. This module adds only what the
 * renderer needs on top: the cross-agent lookups that have no single owning
 * descriptor (a fileName arriving without its dirName, the URL codec) and, in
 * `./presentation`, the icons and copy that cannot live in `shared/` because
 * they are React components.
 *
 * Import this instead of naming an agent. `descriptorForDirName(dirName)` is the
 * source of truth for "which agent is this session?" — the dirName is known
 * before a byte is read and is what the URL carries. `ParsedSession.agentKind`
 * is the parser's own finding and cross-checks it; it never overrides it.
 */
import {
  AGENT_KINDS,
  allDescriptors,
  descriptorFor,
  descriptorForDirName,
  type AgentCapabilities,
  type AgentKind,
} from "../../../shared/session/agent-descriptors"

export type {
  AgentCapabilities,
  AgentDescriptor,
  AgentKind,
  EffortOption,
  ModelOption,
  ServiceTierOption,
} from "../../../shared/session/agent-descriptors"
export {
  AGENT_KINDS,
  agentKindForDirName,
  allDescriptors,
  descriptorFor,
  descriptorForDirName,
  projectDirNameFor,
  soleDescriptorWhere,
} from "../../../shared/session/agent-descriptors"

/**
 * The agent a session belongs to when nothing identifies it — the terminal arm
 * of the detection order, i.e. the agent that owns every unprefixed dirName.
 */
export const DEFAULT_AGENT_KIND: AgentKind = descriptorForDirName(null).kind

/**
 * The agent whose project dirName is lossy, so its directory can only be
 * discovered from the server's project list, never recomputed from a cwd.
 * Null when every agent's encoding round-trips.
 */
export const DISCOVERED_DIRNAME_KIND: AgentKind | null =
  allDescriptors().find((descriptor) => descriptor.dirName.lossy)?.kind ?? null

/** What the agent owning `dirName` can do. */
export function capabilitiesForDirName(dirName: string | null | undefined): AgentCapabilities {
  return descriptorForDirName(dirName).capabilities
}

/** What `kind` can do. */
export function capabilitiesFor(kind: AgentKind): AgentCapabilities {
  return descriptorFor(kind).capabilities
}

/** Narrow an arbitrary server-supplied string to an agent kind. */
export function parseAgentKind(value: unknown, fallback: AgentKind): AgentKind {
  return AGENT_KINDS.find((kind) => kind === value) ?? fallback
}

/**
 * Recover a session id from a transcript fileName when the caller has no
 * dirName to resolve the owning agent with — the sidebar and the PTY bridge
 * both hit this. Each agent is asked in registry order; a bare name that no
 * agent claims keeps today's behaviour of stripping the extension.
 */
export function sessionIdFromFileName(fileName: string): string {
  for (const descriptor of allDescriptors()) {
    const sessionId = descriptor.sessionFile.sessionId(fileName)
    if (sessionId) return sessionId
  }
  return fileName.replace(/\.jsonl$/, "")
}

/** The session identifier a URL carries for a transcript in `dirName`. */
export function sessionUrlIdFromFileName(dirName: string, fileName: string): string {
  return descriptorForDirName(dirName).sessionFile.urlId(fileName)
}

/** Exact inverse of {@link sessionUrlIdFromFileName}. */
export function fileNameFromUrlId(dirName: string, urlId: string): string {
  return descriptorForDirName(dirName).sessionFile.fileNameFromUrlId(urlId)
}

/** The copy-pasteable shell command that reopens a session in a terminal. */
export function getResumeCommand(kind: AgentKind, sessionId: string, cwd?: string): string {
  return descriptorFor(kind).resume.command(sessionId, cwd)
}

/**
 * How Cogpit itself respawns a session. Shares its argv source with
 * {@link getResumeCommand}, so the string a user copies and the process Cogpit
 * starts cannot drift apart.
 */
export function getResumeSpawn(
  kind: AgentKind,
  sessionId: string,
): { command: string; args: string[] } {
  const descriptor = descriptorFor(kind)
  return { command: descriptor.binName, args: [...descriptor.resume.args(sessionId)] }
}

interface ProjectDirEntry {
  dirName: string
  path: string
}

function normalizeProjectPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  return trimmed || "/"
}

/**
 * Find the project directory `kind` would use for `cwd` among the projects the
 * server reported. Needed because Claude's dirName encoding is lossy, so its
 * directory can only be discovered, never recomputed.
 */
export function findProjectDirNameForCwd(
  projects: readonly ProjectDirEntry[],
  cwd: string,
  kind: AgentKind,
): string | null {
  const normalizedCwd = normalizeProjectPath(cwd)
  return projects.find((project) =>
    descriptorForDirName(project.dirName).kind === kind
    && normalizeProjectPath(project.path) === normalizedCwd
  )?.dirName ?? null
}
