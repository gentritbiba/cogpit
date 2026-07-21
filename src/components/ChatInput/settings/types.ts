import type { PermissionMode } from "@/lib/permissions"
import type { AgentKind } from "@/lib/sessionSource"
import type { ServiceTierOption } from "@/lib/utils"

export interface DropdownOption {
  value: string
  label: string
  /** Shown in the dropdown menu only (e.g. "Opus (default)"). */
  menuLabel?: string
  description?: string
}

export interface McpServer {
  name: string
  status: "connected" | "needs_auth" | "error"
}

export interface CommonSettingsControlProps {
  agentKind: AgentKind
  onAgentKindChange?: (agentKind: AgentKind) => void
  selectedModel: string
  resolvedDefaultName: string
  modelOptions: readonly DropdownOption[]
  onModelChange: (model: string) => void
  selectedEffort: string
  effortOptions: readonly DropdownOption[]
  onEffortChange: (effort: string) => void
  fastTier?: ServiceTierOption
  fastModeEnabled?: boolean
  onFastModeEnabledChange?: (enabled: boolean) => void
  isNewSession: boolean
  worktreeEnabled?: boolean
  onWorktreeEnabledChange?: (enabled: boolean) => void
  ultracodeEnabled?: boolean
  onUltracodeEnabledChange?: (enabled: boolean) => void
  autoModeAvailable: boolean
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  mcpServers?: McpServer[]
  selectedMcpServers?: string[]
  onToggleMcpServer?: (name: string) => void
  onRefreshMcpServers?: () => void
  mcpLoading?: boolean
  onMcpAuth?: (serverName: string) => void
  changeAndApply: (apply: () => void) => void
}
