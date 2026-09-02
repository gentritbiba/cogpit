import { descriptorFor, type AgentKind } from "../../shared/session/agent-descriptors"

/** Where an agent's CLI can be installed from, when Cogpit knows. */
const INSTALL_COMMAND: Partial<Record<AgentKind, string>> = {
  claude: "npm install -g @anthropic-ai/claude-code",
}

/**
 * Turn a failed spawn into something a user can act on.
 *
 * Cogpit never vendors an agent, so the common failure is simply that the CLI
 * is not installed — which `ENOENT` alone does not say. Any other error is the
 * OS's own message, which is more specific than anything written here.
 */
export function friendlySpawnError(
  err: NodeJS.ErrnoException,
  kind: AgentKind = "claude",
): string {
  if (err.code !== "ENOENT") return err.message
  const install = INSTALL_COMMAND[kind]
  return `${descriptorFor(kind).displayName} is not installed or not found in PATH.`
    + (install ? ` Install it with: ${install}` : "")
}
