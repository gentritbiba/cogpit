import type { AgentKind } from "@/lib/agents"
import { agentPermissionModes, type PermissionModeOption } from "@/lib/agents/presentation"

export type { PermissionModeOption }

/** The agent's permission modes, minus "auto" where the model cannot offer it. */
export function getPermissionModeOptions(
  agentKind: AgentKind,
  autoAvailable: boolean,
): readonly PermissionModeOption[] {
  return agentPermissionModes(agentKind).filter((option) => option.value !== "auto" || autoAvailable)
}
