import { capabilitiesFor, type AgentKind } from "@/lib/agents"

interface SessionProcessControl {
  managed?: boolean
}

/**
 * True when the session is running under a process Cogpit did not start, so it
 * can be read but not driven. Only agents whose CLI can be attached to
 * out-of-band have this state; for everyone else Cogpit always owns the process.
 */
export function isExternallyDrivenSession(
  agentKind: AgentKind | null | undefined,
  process: SessionProcessControl | null | undefined,
): boolean {
  if (!agentKind) return false
  return capabilitiesFor(agentKind).externalProcesses && process?.managed === false
}
