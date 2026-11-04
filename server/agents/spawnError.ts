import { agentNotInstalledMessage } from "../../shared/session/agentFailures"
import type { AgentKind } from "../../shared/session/agent-descriptors"
import { AgentRuntimeError } from "./runtimeTypes"

/** Code the client reads to offer the agent's install page. */
export const AGENT_NOT_INSTALLED = "AGENT_NOT_INSTALLED"

/** The error a start or send fails with when the agent's CLI is not on this computer. */
export function agentNotInstalledError(kind: AgentKind): AgentRuntimeError {
  return new AgentRuntimeError(500, AGENT_NOT_INSTALLED, agentNotInstalledMessage(kind, process.platform))
}

/**
 * Turn a failed spawn into something a user can act on. `ENOENT` alone does
 * not say that the CLI is missing; any other error is the OS's own message,
 * which is more specific than anything written here.
 */
export function friendlySpawnError(err: NodeJS.ErrnoException, kind: AgentKind): string {
  return err.code === "ENOENT" ? agentNotInstalledMessage(kind, process.platform) : err.message
}
