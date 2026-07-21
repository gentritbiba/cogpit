import { GitBranch, Zap } from "lucide-react"
import { cn, normalizeEffortForAgent } from "@/lib/utils"
import { AgentModelDropdown } from "./AgentModelDropdown"
import { McpDropdown } from "./McpDropdown"
import { MiniDropdown } from "./MiniDropdown"
import { PermissionDropdown } from "./PermissionDropdown"
import type { CommonSettingsControlProps } from "./types"

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
}: CommonSettingsControlProps) {
  const showWorktree = agentKind === "claude"

  return (
    <div className="flex items-center pb-2">
      <div className="w-full flex items-center gap-0.5 flex-wrap">
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
          <>
            <span className="text-border/60 text-[10px] select-none">/</span>
            <MiniDropdown
              value={normalizeEffortForAgent(agentKind, selectedEffort, selectedModel)}
              fallbackLabel="Effort"
              ariaLabel="Reasoning effort"
              options={effortOptions}
              onChange={onEffortChange}
              disabled={ultracodeEnabled}
              title={ultracodeEnabled ? "Effort is pinned to XHigh while Ultracode is on" : undefined}
            />
          </>
        )}

        {fastTier && onFastModeEnabledChange && (
          <>
            <span className="text-border/60 text-[10px] select-none">/</span>
            <button
              type="button"
              aria-pressed={!!fastModeEnabled}
              onClick={() => changeAndApply(() => onFastModeEnabledChange(!fastModeEnabled))}
              title={fastTier.description}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                fastModeEnabled
                  ? "text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Zap className={cn("size-3", fastModeEnabled && "fill-current")} />
              {fastModeEnabled ? "Fast" : "Standard"}
            </button>
          </>
        )}

        {onPermissionModeChange && permissionMode && (
          <>
            <span className="text-border/60 text-[10px] select-none">/</span>
            <PermissionDropdown
              agentKind={agentKind}
              mode={permissionMode}
              onChange={(mode) => changeAndApply(() => onPermissionModeChange(mode))}
              autoAvailable={autoModeAvailable}
            />
          </>
        )}

        {showWorktree && isNewSession && onWorktreeEnabledChange && (
          <>
            <span className="text-border/60 text-[10px] select-none">/</span>
            <button
              type="button"
              aria-pressed={!!worktreeEnabled}
              onClick={() => onWorktreeEnabledChange(!worktreeEnabled)}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                worktreeEnabled
                  ? "text-emerald-400"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5",
              )}
            >
              <GitBranch className="size-3" />
              Worktree
            </button>
          </>
        )}

        {showWorktree && onUltracodeEnabledChange && (
          <>
            <span className="text-border/60 text-[10px] select-none">/</span>
            <button
              type="button"
              aria-pressed={!!ultracodeEnabled}
              onClick={() => changeAndApply(() => onUltracodeEnabledChange(!ultracodeEnabled))}
              title="Ultracode: XHigh effort + standing multi-agent workflow orchestration"
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                ultracodeEnabled
                  ? "text-amber-400"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5",
              )}
            >
              <Zap className={cn("size-3", ultracodeEnabled && "fill-amber-400")} />
              Ultracode
            </button>
          </>
        )}

        {onToggleMcpServer && onRefreshMcpServers && onMcpAuth &&
         (mcpLoading || (mcpServers && mcpServers.length > 0)) && (
          <>
            <span className="text-border/60 text-[10px] select-none">/</span>
            <McpDropdown
              servers={mcpServers ?? []}
              selected={selectedMcpServers ?? []}
              onToggle={(name) => changeAndApply(() => onToggleMcpServer(name))}
              onRefresh={onRefreshMcpServers}
              loading={mcpLoading ?? false}
              onAuth={onMcpAuth}
            />
          </>
        )}

        {!isNewSession && (
          <span className="px-1 text-[9px] text-muted-foreground/70">
            {agentKind === "claude" ? "Changes apply live" : "Changes apply next turn"}
          </span>
        )}
      </div>
    </div>
  )
}
