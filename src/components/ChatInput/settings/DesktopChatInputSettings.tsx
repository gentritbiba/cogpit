import { useId, type ReactNode } from "react"
import { GitBranch, Zap } from "lucide-react"
import { cn, normalizeEffortForAgent } from "@/lib/utils"
import { AgentModelDropdown } from "./AgentModelDropdown"
import { McpDropdown } from "./McpDropdown"
import { MiniDropdown } from "./MiniDropdown"
import { PermissionDropdown } from "./PermissionDropdown"
import type { CommonSettingsControlProps } from "./types"
import { Button } from "@/components/ui/button"

interface DesktopChatInputSettingsProps extends CommonSettingsControlProps {
  /** Additional desktop-only controls appended to the settings row. */
  trailingExtra?: ReactNode
}

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
  trailingExtra,
}: DesktopChatInputSettingsProps) {
  const showWorktree = agentKind === "claude"
  // Whether a change takes effect now or next turn is the one thing this row
  // has to tell you. It used to be a permanent caption; `title` alone would
  // have made it mouse-only, so the group carries it as a description too.
  const applyHintId = useId()
  const applyHint = isNewSession
    ? undefined
    : agentKind === "claude" ? "Changes apply live" : "Changes apply next turn"

  // pl-6 lines the chip labels up with the message placeholder: the composer's
  // px-3 inset + 1px card border + the textarea's pl-4, less the chip's own px-1.5.
  return (
    <div
      className="flex items-center pb-1.5 pl-6 pr-3"
      role="group"
      title={applyHint}
      aria-describedby={applyHint ? applyHintId : undefined}
    >
      {applyHint && <span id={applyHintId} className="sr-only">{applyHint}</span>}
      <div className="flex w-full flex-wrap items-center gap-1.5">
        {onAgentKindChange
          ? (
            <AgentModelDropdown
              agentKind={agentKind}
              onAgentKindChange={onAgentKindChange}
              value={selectedModel}
              fallbackLabel={resolvedDefaultName}
              options={modelOptions}
              onChange={onModelChange}
            />
          )
          : (
            <MiniDropdown
              value={selectedModel}
              fallbackLabel="Model"
              ariaLabel="Model"
              options={modelOptions}
              onChange={onModelChange}
            />
          )}

        {effortOptions.length > 0 && (
          <MiniDropdown
            value={normalizeEffortForAgent(agentKind, selectedEffort, selectedModel)}
            fallbackLabel="Effort"
            ariaLabel="Reasoning effort"
            options={effortOptions}
            onChange={onEffortChange}
            disabled={ultracodeEnabled}
            title={ultracodeEnabled ? "Effort is pinned to XHigh while Ultracode is on" : undefined}
          />
        )}

        {fastTier && onFastModeEnabledChange && (
          <Button
            type="button"
            variant={fastModeEnabled ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={!!fastModeEnabled}
            onClick={() => changeAndApply(() => onFastModeEnabledChange(!fastModeEnabled))}
            title={fastTier.description}
          >
            <Zap data-icon="inline-start" className={cn(fastModeEnabled && "fill-current")} />
            {fastModeEnabled ? "Fast" : "Standard"}
          </Button>
        )}

        {onPermissionModeChange && permissionMode && (
          <PermissionDropdown
            agentKind={agentKind}
            mode={permissionMode}
            onChange={(mode) => changeAndApply(() => onPermissionModeChange(mode))}
            autoAvailable={autoModeAvailable}
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

        {showWorktree && onUltracodeEnabledChange && (
          <Button
            type="button"
            variant={ultracodeEnabled ? "secondary" : "ghost"}
            size="xs"
            aria-pressed={!!ultracodeEnabled}
            onClick={() => changeAndApply(() => onUltracodeEnabledChange(!ultracodeEnabled))}
            title="Ultracode: XHigh effort + standing multi-agent workflow orchestration"
          >
            <Zap data-icon="inline-start" className={cn(ultracodeEnabled && "fill-current")} />
            Ultracode
          </Button>
        )}

        {onToggleMcpServer && onRefreshMcpServers && onMcpAuth &&
         (mcpLoading || (mcpServers && mcpServers.length > 0)) && (
          <McpDropdown
            servers={mcpServers ?? []}
            selected={selectedMcpServers ?? []}
            onToggle={(name) => changeAndApply(() => onToggleMcpServer(name))}
            onRefresh={onRefreshMcpServers}
            loading={mcpLoading ?? false}
            onAuth={onMcpAuth}
          />
        )}
        {trailingExtra}
      </div>
    </div>
  )
}
