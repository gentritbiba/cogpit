import { memo, useCallback, useState, type ReactNode } from "react"
import {
  getEffortOptions,
  getFastServiceTierOption,
  supportsAutoPermissionMode,
} from "@/lib/utils"
import { useModelOptions } from "@/hooks/useModelOptions"
import { DEFAULT_AGENT_KIND, type AgentKind } from "@/lib/agents"
import type { PermissionMode } from "@/lib/permissions"
import { DesktopChatInputSettings } from "./settings/DesktopChatInputSettings"
import { MobileChatInputSettings } from "./settings/MobileChatInputSettings"
import { friendlyModelName, resolveDefaultModelName } from "./settings/modelOptions"
import type { CommonSettingsControlProps, DropdownOption } from "./settings/types"

export interface ChatInputSettingsProps {
  agentKind?: AgentKind
  onAgentKindChange?: (agentKind: AgentKind) => void
  selectedModel: string
  onModelChange: (model: string) => void
  selectedEffort: string
  onEffortChange: (effort: string) => void
  fastModeEnabled?: boolean
  onFastModeEnabledChange?: (enabled: boolean) => void
  isNewSession: boolean
  worktreeEnabled?: boolean
  onWorktreeEnabledChange?: (enabled: boolean) => void
  /** Ultracode toggle state (xhigh effort + standing workflow orchestration) */
  ultracodeEnabled?: boolean
  /** Provided only when ultracode is available (Claude + new session + capable model) */
  onUltracodeEnabledChange?: (enabled: boolean) => void
  onApplySettings?: () => Promise<void>
  /** Model ID from the active session (e.g. "claude-opus-4-6"), used to resolve "Default" label */
  activeModelId?: string
  /** MCP servers available for this project */
  mcpServers?: Array<{ name: string; status: "connected" | "needs_auth" | "error" }>
  /** Currently selected MCP server names */
  selectedMcpServers?: string[]
  /** Toggle an MCP server on/off */
  onToggleMcpServer?: (name: string) => void
  /** Refresh MCP server status */
  onRefreshMcpServers?: () => void
  /** Loading MCP status */
  mcpLoading?: boolean
  /** Called when a needs-auth server is clicked */
  onMcpAuth?: (serverName: string) => void
  /** Current permission mode */
  permissionMode?: PermissionMode
  /** Called when permission mode changes */
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Additional mobile-only controls rendered inside the settings sheet. */
  mobileExtra?: ReactNode
  /** Additional desktop-only controls appended to the settings row. */
  trailingExtra?: ReactNode
  /** Renders the compact mobile trigger and bottom sheet. */
  mobile?: boolean
}

export const ChatInputSettings = memo(function ChatInputSettings({
  agentKind = DEFAULT_AGENT_KIND,
  onAgentKindChange,
  selectedModel,
  onModelChange,
  selectedEffort,
  onEffortChange,
  fastModeEnabled,
  onFastModeEnabledChange,
  isNewSession,
  worktreeEnabled,
  onWorktreeEnabledChange,
  ultracodeEnabled,
  onUltracodeEnabledChange,
  onApplySettings,
  activeModelId,
  mcpServers,
  selectedMcpServers,
  onToggleMcpServer,
  onRefreshMcpServers,
  mcpLoading,
  onMcpAuth,
  permissionMode,
  onPermissionModeChange,
  mobileExtra,
  trailingExtra,
  mobile = false,
}: ChatInputSettingsProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  /** Apply a setting change and auto-apply to the active session if applicable. */
  const changeAndApply = useCallback((apply: () => void) => {
    apply()
    if (!isNewSession && onApplySettings) {
      setTimeout(() => onApplySettings(), 0)
    }
  }, [isNewSession, onApplySettings])

  const handleModelChange = useCallback(
    (model: string) => changeAndApply(() => onModelChange(model)),
    [onModelChange, changeAndApply],
  )

  const handleEffortChange = useCallback(
    (effort: string) => changeAndApply(() => onEffortChange(effort)),
    [onEffortChange, changeAndApply],
  )

  // Claude and Codex model families are distinguishable by id. Copilot offers
  // models from several families, so its active model always belongs here.
  const catalogOptions = useModelOptions(agentKind)
  const activeModelIsCodex = activeModelId?.toLowerCase().startsWith("gpt-") ?? false
  const activeModelMatchesProvider = agentKind === "copilot"
    || activeModelIsCodex === (agentKind === "codex")
  const sessionModelId = activeModelId && activeModelMatchesProvider
    ? activeModelId
    : undefined
  // What "Default" means right now: the active session's model when there is
  // one, otherwise whatever the catalog says its default resolves to. Both
  // come straight from the provider CLI — never a hardcoded model name.
  const resolvedDefaultName = sessionModelId
    ? friendlyModelName(sessionModelId, catalogOptions)
    : resolveDefaultModelName(catalogOptions)
  const modelOptions: readonly DropdownOption[] = catalogOptions.map((option) => {
    const description = [option.description, option.availabilityMessage].filter(Boolean).join(" · ") || undefined
    return option.value === ""
      ? { ...option, description, label: resolvedDefaultName, menuLabel: option.label }
      : { ...option, description }
  })
  const effortOptions = getEffortOptions(agentKind, selectedModel)
  const fastTier = getFastServiceTierOption(agentKind, selectedModel)
  const autoModeAvailable = supportsAutoPermissionMode(agentKind, selectedModel)
  const commonSettingsProps: CommonSettingsControlProps = {
    agentKind,
    onAgentKindChange,
    selectedModel,
    resolvedDefaultName,
    modelOptions,
    onModelChange: handleModelChange,
    selectedEffort,
    effortOptions,
    onEffortChange: handleEffortChange,
    fastTier,
    fastModeEnabled,
    onFastModeEnabledChange,
    isNewSession,
    worktreeEnabled,
    onWorktreeEnabledChange,
    ultracodeEnabled,
    onUltracodeEnabledChange,
    autoModeAvailable,
    permissionMode,
    onPermissionModeChange,
    mcpServers,
    selectedMcpServers,
    onToggleMcpServer,
    onRefreshMcpServers,
    mcpLoading,
    onMcpAuth,
    changeAndApply,
  }

  if (mobile) {
    return (
      <MobileChatInputSettings
        {...commonSettingsProps}
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        catalogOptions={catalogOptions}
        mobileExtra={mobileExtra}
      />
    )
  }

  return <DesktopChatInputSettings {...commonSettingsProps} trailingExtra={trailingExtra} />
})
