import type { PermissionMode } from "@/lib/permissions"
import type { AgentKind } from "@/lib/sessionSource"

export interface PermissionModeOption {
  value: PermissionMode
  label: string
  description: string
}

const CLAUDE_PERMISSION_MODES: readonly PermissionModeOption[] = [
  { value: "default", label: "Ask", description: "Ask before sensitive actions" },
  { value: "plan", label: "Plan", description: "Read and plan without changing files" },
  { value: "acceptEdits", label: "Accept Edits", description: "Allow file edits; ask for other actions" },
  { value: "auto", label: "Auto", description: "Run autonomously with classifier safeguards" },
  { value: "dontAsk", label: "Don't Ask", description: "Deny actions that need approval" },
  { value: "bypassPermissions", label: "Full access", description: "Skip permission checks" },
]

const CODEX_PERMISSION_MODES: readonly PermissionModeOption[] = [
  { value: "default", label: "Workspace", description: "Write inside the project sandbox" },
  { value: "plan", label: "Read only", description: "Inspect and plan without writing" },
  { value: "bypassPermissions", label: "Full access", description: "No sandbox or approval checks" },
]

export function getPermissionModeOptions(
  agentKind: AgentKind,
  autoAvailable: boolean,
): readonly PermissionModeOption[] {
  return agentKind === "codex"
    ? CODEX_PERMISSION_MODES
    : CLAUDE_PERMISSION_MODES.filter((option) => option.value !== "auto" || autoAvailable)
}
