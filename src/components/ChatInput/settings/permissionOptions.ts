import type { PermissionMode } from "@/lib/permissions"
import type { AgentKind } from "@/lib/sessionSource"

export interface PermissionModeOption {
  value: PermissionMode
  label: string
  description: string
  color: string
}

const CLAUDE_PERMISSION_MODES: readonly PermissionModeOption[] = [
  { value: "default", label: "Ask", description: "Ask before sensitive actions", color: "text-blue-400" },
  { value: "plan", label: "Plan", description: "Read and plan without changing files", color: "text-purple-400" },
  { value: "acceptEdits", label: "Accept Edits", description: "Allow file edits; ask for other actions", color: "text-green-400" },
  { value: "auto", label: "Auto", description: "Run autonomously with classifier safeguards", color: "text-cyan-400" },
  { value: "dontAsk", label: "Don't Ask", description: "Deny actions that need approval", color: "text-amber-400" },
  { value: "bypassPermissions", label: "Full access", description: "Skip permission checks", color: "text-red-400" },
]

const CODEX_PERMISSION_MODES: readonly PermissionModeOption[] = [
  { value: "default", label: "Workspace", description: "Write inside the project sandbox", color: "text-blue-400" },
  { value: "plan", label: "Read only", description: "Inspect and plan without writing", color: "text-purple-400" },
  { value: "bypassPermissions", label: "Full access", description: "No sandbox or approval checks", color: "text-red-400" },
]

export function getPermissionModeOptions(
  agentKind: AgentKind,
  autoAvailable: boolean,
): readonly PermissionModeOption[] {
  return agentKind === "codex"
    ? CODEX_PERMISSION_MODES
    : CLAUDE_PERMISSION_MODES.filter((option) => option.value !== "auto" || autoAvailable)
}
