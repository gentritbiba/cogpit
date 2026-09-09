import type { PermissionMode } from "@/lib/permissions"
import type { AgentKind } from "@/lib/agents"
import type { ServiceTierOption } from "@/lib/utils"
import type { McpServer } from "../../../../shared/contracts/projectTools"

export interface SettingOption {
  value: string
  label: string
  /** Shown in the picker list only (e.g. "Default (recommended)"). */
  menuLabel?: string
  description?: string
}

export interface CommonSettingsControlProps {
  agentKind: AgentKind
  onAgentKindChange?: (agentKind: AgentKind) => void
  selectedModel: string
  resolvedDefaultName: string
  modelOptions: readonly SettingOption[]
  onModelChange: (model: string) => void
  /** Already clamped to one of `effortOptions`, or "" when the model offers none. */
  selectedEffort: string
  effortOptions: readonly SettingOption[]
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
  onSetMcpServers?: (names: string[]) => void
  onRefreshMcpServers?: () => void
  mcpLoading?: boolean
  onMcpAuth?: (serverName: string) => void
  changeAndApply: (apply: () => void) => void
}
