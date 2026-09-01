import type { AgentKind } from "../../shared/providers/types"

interface SessionProcessControl {
  managed?: boolean
}

export function isExternalCopilotSession(
  agentKind: AgentKind | null | undefined,
  process: SessionProcessControl | null | undefined,
): boolean {
  return agentKind === "copilot" && process?.managed === false
}
