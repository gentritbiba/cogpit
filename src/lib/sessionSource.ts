/**
 * Session source utilities — thin re-exports and wrappers over src/lib/providers.
 * All implementations live in the provider modules; this file exists for
 * backwards compatibility and as a convenience import for client code.
 */
import { getProvider, inferAgentKind } from "./providers/registry"

export type { AgentKind } from "./providers/types"
export { isCodexDirName, encodeCodexDirName } from "./providers/codex"
export { inferAgentKind as inferSessionSourceKind, inferAgentKind as agentKindFromDirName } from "./providers/registry"

/** @deprecated Alias for AgentKind — use AgentKind directly */
export type SessionSourceKind = import("./providers/types").AgentKind

export function getResumeCommand(agentKind: import("./providers/types").AgentKind, sessionId: string): string {
  return getProvider(agentKind).resumeCommand(sessionId)
}

// Re-export inferAgentKind as the canonical name for server-side callers
export { inferAgentKind }
