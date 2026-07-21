import type { ReactNode } from "react"
import { GitBranch, RefreshCw, Settings2, X, Zap } from "lucide-react"
import {
  cn,
  normalizeEffortForAgent,
  type ModelOption,
} from "@/lib/utils"
import type { PermissionMode } from "@/lib/permissions"
import type { AgentKind } from "@/lib/sessionSource"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { FullAccessDialog } from "./PermissionDropdown"
import { AGENT_OPTIONS, friendlyModelName } from "./modelOptions"
import { getPermissionModeOptions, type PermissionModeOption } from "./permissionOptions"
import type { CommonSettingsControlProps, DropdownOption, McpServer } from "./types"

const MOBILE_SELECT_CLASS =
  "h-10 w-full rounded-md bg-transparent text-xs font-medium text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:text-muted-foreground/50"

interface MobileControlProps {
  label: string
  children: ReactNode
  wide?: boolean
}

function MobileControl({ label, children, wide = false }: MobileControlProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl border border-border/40 bg-elevation-2 px-2.5 py-2",
        wide && "col-span-2",
      )}
    >
      <span className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </span>
      <div className="min-w-0 [&>button]:w-full [&>button]:justify-between [&>button]:px-0">
        {children}
      </div>
    </div>
  )
}

interface MobileSelectControlProps {
  label: string
  ariaLabel: string
  value: string
  options: ReadonlyArray<{ value: string; label: string; menuLabel?: string }>
  onChange: (value: string) => void
  disabled?: boolean
  title?: string
}

function MobileSelectControl({
  label,
  ariaLabel,
  value,
  options,
  onChange,
  disabled,
  title,
}: MobileSelectControlProps) {
  return (
    <MobileControl label={label}>
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        title={title}
        className={MOBILE_SELECT_CLASS}
      >
        {options.map((option) => (
          <option key={option.value || "default"} value={option.value}>
            {option.menuLabel ?? option.label}
          </option>
        ))}
      </select>
    </MobileControl>
  )
}

interface MobileModelControlsProps {
  agentKind: AgentKind
  onAgentKindChange?: (agentKind: AgentKind) => void
  selectedModel: string
  onModelChange: (model: string) => void
  modelOptions: readonly DropdownOption[]
  selectedEffort: string
  onEffortChange: (effort: string) => void
  effortOptions: readonly DropdownOption[]
  ultracodeEnabled?: boolean
  fastTier?: CommonSettingsControlProps["fastTier"]
  fastModeEnabled?: boolean
  onFastModeEnabledChange?: (enabled: boolean) => void
  permissionMode?: PermissionMode
  permissionOptions: readonly PermissionModeOption[]
  onPermissionModeChange?: (mode: PermissionMode) => void
  changeAndApply: (apply: () => void) => void
}

function MobileModelControls({
  agentKind,
  onAgentKindChange,
  selectedModel,
  onModelChange,
  modelOptions,
  selectedEffort,
  onEffortChange,
  effortOptions,
  ultracodeEnabled,
  fastTier,
  fastModeEnabled,
  onFastModeEnabledChange,
  permissionMode,
  permissionOptions,
  onPermissionModeChange,
  changeAndApply,
}: MobileModelControlsProps) {
  const normalizedEffort = normalizeEffortForAgent(agentKind, selectedEffort, selectedModel)

  return (
    <section aria-labelledby="mobile-model-controls" className="flex flex-col gap-2">
      <h3 id="mobile-model-controls" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Model and behavior
      </h3>
      <div className="grid grid-cols-2 gap-2">
        {onAgentKindChange && (
          <MobileSelectControl
            label="Agent"
            ariaLabel="Agent"
            value={agentKind}
            options={AGENT_OPTIONS}
            onChange={(value) => onAgentKindChange(value as AgentKind)}
          />
        )}

        <MobileSelectControl
          label="Model"
          ariaLabel="Model"
          value={selectedModel}
          options={modelOptions}
          onChange={onModelChange}
        />

        {effortOptions.length > 0 && (
          <MobileSelectControl
            label="Reasoning"
            ariaLabel="Reasoning effort"
            value={normalizedEffort}
            options={effortOptions}
            onChange={onEffortChange}
            disabled={ultracodeEnabled}
            title={ultracodeEnabled ? "Effort is pinned to XHigh while Ultracode is on" : undefined}
          />
        )}

        {fastTier && onFastModeEnabledChange && (
          <MobileControl label="Speed">
            <button
              type="button"
              aria-pressed={!!fastModeEnabled}
              onClick={() => changeAndApply(() => onFastModeEnabledChange(!fastModeEnabled))}
              title={fastTier.description}
              className={cn(
                "flex h-10 items-center gap-1 text-xs font-medium transition-colors",
                fastModeEnabled ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Zap className={cn("size-3.5", fastModeEnabled && "fill-current")} />
              {fastModeEnabled ? "Fast" : "Standard"}
            </button>
          </MobileControl>
        )}

        {onPermissionModeChange && permissionMode && (
          <MobileSelectControl
            label="Access"
            ariaLabel="Access policy"
            value={permissionMode}
            options={permissionOptions}
            onChange={(value) => onPermissionModeChange(value as PermissionMode)}
          />
        )}
      </div>
    </section>
  )
}

interface MobileAdvancedControlsProps {
  agentKind: AgentKind
  isNewSession: boolean
  worktreeEnabled?: boolean
  onWorktreeEnabledChange?: (enabled: boolean) => void
  ultracodeEnabled?: boolean
  onUltracodeEnabledChange?: (enabled: boolean) => void
  mcpServers?: McpServer[]
  selectedMcpServers?: string[]
  onToggleMcpServer?: (name: string) => void
  onRefreshMcpServers?: () => void
  mcpLoading?: boolean
  onMcpAuth?: (serverName: string) => void
  changeAndApply: (apply: () => void) => void
}

function MobileAdvancedControls({
  agentKind,
  isNewSession,
  worktreeEnabled,
  onWorktreeEnabledChange,
  ultracodeEnabled,
  onUltracodeEnabledChange,
  mcpServers,
  selectedMcpServers,
  onToggleMcpServer,
  onRefreshMcpServers,
  mcpLoading,
  onMcpAuth,
  changeAndApply,
}: MobileAdvancedControlsProps) {
  const showWorktree = agentKind === "claude"
  const showMcp = Boolean(
    onToggleMcpServer &&
    onRefreshMcpServers &&
    onMcpAuth &&
    (mcpLoading || (mcpServers && mcpServers.length > 0)),
  )
  const showAdvanced = Boolean(
    (showWorktree && isNewSession && onWorktreeEnabledChange) ||
    (showWorktree && onUltracodeEnabledChange) ||
    showMcp,
  )
  const selectedNames = new Set(selectedMcpServers ?? [])

  if (!showAdvanced) return null

  return (
    <section aria-labelledby="mobile-advanced-controls" className="flex flex-col gap-2">
      <h3 id="mobile-advanced-controls" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Advanced
      </h3>
      <div className="grid grid-cols-2 gap-2">
        {showWorktree && isNewSession && onWorktreeEnabledChange && (
          <MobileControl label="Isolation">
            <button
              type="button"
              aria-pressed={!!worktreeEnabled}
              onClick={() => onWorktreeEnabledChange(!worktreeEnabled)}
              className={cn(
                "flex h-10 items-center gap-1 text-xs font-medium transition-colors",
                worktreeEnabled ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <GitBranch className="size-3.5" />
              Worktree
            </button>
          </MobileControl>
        )}

        {showWorktree && onUltracodeEnabledChange && (
          <MobileControl label="Workflow">
            <button
              type="button"
              aria-pressed={!!ultracodeEnabled}
              onClick={() => changeAndApply(() => onUltracodeEnabledChange(!ultracodeEnabled))}
              className={cn(
                "flex h-10 items-center gap-1 text-xs font-medium transition-colors",
                ultracodeEnabled ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Zap className={cn("size-3.5", ultracodeEnabled && "fill-current")} />
              Ultracode
            </button>
          </MobileControl>
        )}

        {showMcp && onToggleMcpServer && onRefreshMcpServers && onMcpAuth && (
          <MobileControl label="Connections" wide>
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={onRefreshMcpServers}
                className="flex min-h-10 items-center gap-2 text-xs font-medium text-muted-foreground"
              >
                <RefreshCw className={cn("size-3.5", mcpLoading && "animate-spin")} />
                Refresh MCP status
              </button>
              {(mcpServers ?? []).map((server) => {
                const selected = selectedNames.has(server.name)
                const connected = server.status === "connected"
                return (
                  <button
                    key={server.name}
                    type="button"
                    aria-pressed={connected ? selected : undefined}
                    onClick={() => connected
                      ? changeAndApply(() => onToggleMcpServer(server.name))
                      : onMcpAuth(server.name)}
                    className="flex min-h-10 items-center gap-2 rounded-lg border border-border/30 px-2 text-left text-xs text-foreground"
                  >
                    <span className={cn(
                      "size-2 shrink-0 rounded-full",
                      connected && selected
                        ? "bg-emerald-500"
                        : connected ? "bg-muted-foreground" : "bg-amber-500",
                    )} />
                    <span className="min-w-0 flex-1 truncate">{server.name}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {connected ? (selected ? "On" : "Off") : "Connect"}
                    </span>
                  </button>
                )
              })}
            </div>
          </MobileControl>
        )}
      </div>
    </section>
  )
}

interface MobileChatInputSettingsProps extends CommonSettingsControlProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  pendingPermission: PermissionMode | null
  onPendingPermissionChange: (mode: PermissionMode | null) => void
  catalogOptions: readonly ModelOption[]
  mobileExtra?: ReactNode
}

export function MobileChatInputSettings({
  open,
  onOpenChange,
  pendingPermission,
  onPendingPermissionChange,
  agentKind,
  onAgentKindChange,
  selectedModel,
  resolvedDefaultName,
  catalogOptions,
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
  mobileExtra,
  changeAndApply,
}: MobileChatInputSettingsProps) {
  const normalizedEffort = normalizeEffortForAgent(agentKind, selectedEffort, selectedModel)
  const permissionOptions = getPermissionModeOptions(agentKind, autoModeAvailable)
  const permissionLabel = permissionOptions.find((option) => option.value === permissionMode)?.label
  const summary = [
    selectedModel ? friendlyModelName(selectedModel, catalogOptions) : resolvedDefaultName,
    effortOptions.find((option) => option.value === normalizedEffort)?.label,
    permissionLabel,
  ].filter(Boolean).join(" · ")

  const changeMobilePermission = (nextMode: PermissionMode) => {
    if (nextMode === "bypassPermissions" && permissionMode !== "bypassPermissions") {
      onOpenChange(false)
      onPendingPermissionChange(nextMode)
      return
    }
    if (onPermissionModeChange) {
      changeAndApply(() => onPermissionModeChange(nextMode))
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger
          render={(
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-0.5 size-10 shrink-0 rounded-full text-muted-foreground"
              aria-label="Session controls"
              title="Session controls"
            />
          )}
        >
          <Settings2 />
        </SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[82dvh] overflow-hidden rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
          showCloseButton={false}
        >
          <SheetHeader className="gap-1 px-4 pb-3 pt-4">
            <SheetTitle>Session controls</SheetTitle>
            <SheetDescription className="truncate text-xs">{summary}</SheetDescription>
            <SheetClose
              render={(
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-2 size-10"
                  aria-label="Close session controls"
                />
              )}
            >
              <X />
            </SheetClose>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            <MobileModelControls
              agentKind={agentKind}
              onAgentKindChange={onAgentKindChange}
              selectedModel={selectedModel}
              onModelChange={onModelChange}
              modelOptions={modelOptions}
              selectedEffort={selectedEffort}
              onEffortChange={onEffortChange}
              effortOptions={effortOptions}
              ultracodeEnabled={ultracodeEnabled}
              fastTier={fastTier}
              fastModeEnabled={fastModeEnabled}
              onFastModeEnabledChange={onFastModeEnabledChange}
              permissionMode={permissionMode}
              permissionOptions={permissionOptions}
              onPermissionModeChange={changeMobilePermission}
              changeAndApply={changeAndApply}
            />

            <MobileAdvancedControls
              agentKind={agentKind}
              isNewSession={isNewSession}
              worktreeEnabled={worktreeEnabled}
              onWorktreeEnabledChange={onWorktreeEnabledChange}
              ultracodeEnabled={ultracodeEnabled}
              onUltracodeEnabledChange={onUltracodeEnabledChange}
              mcpServers={mcpServers}
              selectedMcpServers={selectedMcpServers}
              onToggleMcpServer={onToggleMcpServer}
              onRefreshMcpServers={onRefreshMcpServers}
              mcpLoading={mcpLoading}
              onMcpAuth={onMcpAuth}
              changeAndApply={changeAndApply}
            />

            {mobileExtra && (
              <section aria-labelledby="mobile-goal-controls" className="flex flex-col gap-2 border-t border-border/40 pt-4">
                <h3 id="mobile-goal-controls" className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Long-running goal
                </h3>
                <div className="[&>*]:mx-0 [&>*]:mb-0 [&_button]:min-h-10">{mobileExtra}</div>
              </section>
            )}

            {!isNewSession && (
              <p className="text-[10px] text-muted-foreground">
                {agentKind === "claude" ? "Changes apply live." : "Changes apply on the next turn."}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <FullAccessDialog
        agentKind={agentKind}
        open={pendingPermission === "bypassPermissions"}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) onPendingPermissionChange(null)
        }}
        onConfirm={() => {
          if (onPermissionModeChange) {
            changeAndApply(() => onPermissionModeChange("bypassPermissions"))
          }
          onPendingPermissionChange(null)
        }}
      />
    </>
  )
}
