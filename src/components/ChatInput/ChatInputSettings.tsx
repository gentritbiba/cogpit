import { memo, useCallback, useState, type ReactNode } from "react"
import {
  getEffortOptions,
  getFastServiceTierOption,
  supportsAutoPermissionMode,
} from "@/lib/utils"
import { useModelOptions } from "@/hooks/useModelOptions"
import type { AgentKind } from "@/lib/sessionSource"
import type { PermissionMode } from "@/lib/permissions"
import { DesktopChatInputSettings } from "./settings/DesktopChatInputSettings"
import { MobileChatInputSettings } from "./settings/MobileChatInputSettings"
import { friendlyModelName } from "./settings/modelOptions"
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
  /** Renders the compact mobile trigger and bottom sheet. */
  mobile?: boolean
}

export const ChatInputSettings = memo(function ChatInputSettings({
  agentKind = "claude",
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

  // Scope model options to the current agent so a Codex session never shows
  // a Claude model name (and vice versa).
  const catalogOptions = useModelOptions(agentKind)
  const providerDefaultLabel = catalogOptions.find((option) => option.value !== "")?.label
  const resolvedDefaultName = agentKind === "codex"
    ? (activeModelId?.toLowerCase().startsWith("gpt-")
        ? friendlyModelName(activeModelId, catalogOptions)
        : providerDefaultLabel ?? "GPT")
    : (activeModelId ? friendlyModelName(activeModelId, catalogOptions) : "Opus")
  const modelOptions: readonly DropdownOption[] = catalogOptions.map((option) => {
    const description = [option.description, option.availabilityMessage].filter(Boolean).join(" · ") || undefined
    return option.value === ""
      ? {
          ...option,
          description,
          value: "",
          label: resolvedDefaultName,
          menuLabel: `${resolvedDefaultName} (default)`,
        }
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

  return <DesktopChatInputSettings {...commonSettingsProps} />
})
