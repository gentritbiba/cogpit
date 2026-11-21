import type { ReactNode } from "react"
import { GitBranch } from "lucide-react"
import { McpPicker } from "./McpPicker"
import { ModelPicker } from "./ModelPicker"
import { PermissionPicker } from "./PermissionPicker"
import { QUIET_CHIPS } from "./PickerShell"
import type { CommonSettingsControlProps } from "./types"
import { Button } from "@/components/ui/button"
import { ContextMeter, sessionContextUsage } from "@/components/header-shared"
import { useOpenSession, useSessionControlsOptional } from "@/contexts/SessionContext"
import { capabilitiesFor } from "@/lib/agents"
import { cn } from "@/lib/utils"

interface DesktopChatInputSettingsProps extends CommonSettingsControlProps {
  /** Additional desktop-only controls appended after the built-in chips. */
  trailingExtra?: ReactNode
}

/**
 * The composer's bottom row: session controls on the left; the context left
 * and the model picker beside Send. Before a session starts the controls carry their labels, since
 * choosing them is the task; once it runs they recede to icons.
 */
export function DesktopChatInputSettings({
  agentKind,
  onAgentKindChange,
  selectedModel,
  resolvedDefaultName,
  modelOptions,
  onModelChange,
  selectedEffort,
  effortOptions,
  onEffortChange,
  contextWindowTokens,
  onContextWindowTokensChange,
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
  onSetMcpServers,
  onRefreshMcpServers,
  mcpLoading,
  onMcpAuth,
  changeAndApply,
  trailingExtra,
}: DesktopChatInputSettingsProps) {
  const { worktrees: showWorktree } = capabilitiesFor(agentKind)
  const dirName = useSessionControlsOptional()?.sessionSource?.dirName
  const contextUsage = useOpenSession((session) => session ? sessionContextUsage(session, dirName) : null)

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1" role="group" aria-label="Session settings">
      <div
        data-quiet={isNewSession ? undefined : ""}
        className={cn(QUIET_CHIPS, "flex min-w-0 flex-1 flex-wrap items-center gap-1 data-quiet:gap-0 data-quiet:text-muted-foreground")}
      >
        {onPermissionModeChange && permissionMode && (
          <PermissionPicker
            agentKind={agentKind}
            mode={permissionMode}
            onChange={(mode) => changeAndApply(() => onPermissionModeChange(mode))}
            autoAvailable={autoModeAvailable}
            isNewSession={isNewSession}
          />
        )}

        {showWorktree && isNewSession && onWorktreeEnabledChange && (
          <Button
            type="button"
            variant={worktreeEnabled ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={!!worktreeEnabled}
            onClick={() => onWorktreeEnabledChange(!worktreeEnabled)}
          >
            <GitBranch data-icon="inline-start" />
            Worktree
          </Button>
        )}

        {onToggleMcpServer && onRefreshMcpServers && onMcpAuth &&
         (mcpLoading || (mcpServers && mcpServers.length > 0)) && (
          <McpPicker
            servers={mcpServers ?? []}
            selected={selectedMcpServers ?? []}
            onToggle={(name) => changeAndApply(() => onToggleMcpServer(name))}
            onSetSelection={onSetMcpServers
              ? (names) => changeAndApply(() => onSetMcpServers(names))
              : undefined}
            onRefresh={onRefreshMcpServers}
            loading={mcpLoading ?? false}
            onAuth={onMcpAuth}
            isNewSession={isNewSession}
          />
        )}
        {trailingExtra}
      </div>

      <ContextMeter usage={contextUsage} />

      <ModelPicker
        agentKind={agentKind}
        onAgentKindChange={onAgentKindChange}
        selectedModel={selectedModel}
        resolvedDefaultName={resolvedDefaultName}
        modelOptions={modelOptions}
        onModelChange={onModelChange}
        selectedEffort={selectedEffort}
        effortOptions={effortOptions}
        onEffortChange={onEffortChange}
        contextWindowTokens={contextWindowTokens}
        onContextWindowTokensChange={onContextWindowTokensChange}
        fastTier={fastTier}
        fastModeEnabled={fastModeEnabled}
        onFastModeEnabledChange={onFastModeEnabledChange
          ? (enabled) => changeAndApply(() => onFastModeEnabledChange(enabled))
          : undefined}
        ultracodeEnabled={ultracodeEnabled}
        onUltracodeEnabledChange={onUltracodeEnabledChange
          ? (enabled) => changeAndApply(() => onUltracodeEnabledChange(enabled))
          : undefined}
        isNewSession={isNewSession}
      />
    </div>
  )
}
