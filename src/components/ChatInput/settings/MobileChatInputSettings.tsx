import type { ReactNode } from "react"
import { GitBranch, RefreshCw, Settings2, X, Zap } from "lucide-react"
import { cn, type ModelOption } from "@/lib/utils"
import type { PermissionMode } from "@/lib/permissions"
import type { AgentKind } from "@/lib/agents"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { AGENT_OPTIONS, friendlyModelName } from "./modelOptions"
import { getPermissionModeOptions, type PermissionModeOption } from "./permissionOptions"
import type { CommonSettingsControlProps, SettingOption, McpServer } from "./types"
import { capabilitiesFor } from "@/lib/agents"

interface MobileControlProps {
  label: string
  children: ReactNode
  wide?: boolean
}

function MobileControl({ label, children, wide = false }: MobileControlProps) {
  return (
    <Field
      className={cn(
        "min-w-0 gap-1 py-1",
        wide && "col-span-2",
      )}
    >
      <FieldLabel className="text-xs text-muted-foreground">
        {label}
      </FieldLabel>
      <div className="min-w-0 [&>button]:w-full [&>button]:justify-between">
        {children}
      </div>
    </Field>
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
      <Select
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue !== null) onChange(nextValue)
        }}
        disabled={disabled}
      >
        <SelectTrigger
          aria-label={ariaLabel}
          title={title}
          className="h-10 w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value || "default"} value={option.value}>
                {option.menuLabel ?? option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </MobileControl>
  )
}

interface MobileModelControlsProps {
  agentKind: AgentKind
  onAgentKindChange?: (agentKind: AgentKind) => void
  selectedModel: string
  onModelChange: (model: string) => void
  modelOptions: readonly SettingOption[]
  selectedEffort: string
  onEffortChange: (effort: string) => void
  effortOptions: readonly SettingOption[]
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
  return (
    <section aria-labelledby="mobile-model-controls" className="flex flex-col gap-2">
      <h3 id="mobile-model-controls" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
            value={selectedEffort}
            options={effortOptions}
            onChange={onEffortChange}
            disabled={ultracodeEnabled}
            title={ultracodeEnabled ? "Effort is pinned to XHigh while Ultracode is on" : undefined}
          />
        )}

        {fastTier && onFastModeEnabledChange && (
          <MobileControl label="Speed">
            <Button
              type="button"
              variant={fastModeEnabled ? "secondary" : "ghost"}
              aria-pressed={!!fastModeEnabled}
              onClick={() => changeAndApply(() => onFastModeEnabledChange(!fastModeEnabled))}
              title={fastTier.description}
              className="h-10 justify-start"
            >
              <Zap data-icon="inline-start" className={cn(fastModeEnabled && "fill-current")} />
              {fastModeEnabled ? "Fast" : "Standard"}
            </Button>
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
  const { worktrees: showWorktree, ultracode: showUltracode } = capabilitiesFor(agentKind)
  const showMcp = Boolean(
    onToggleMcpServer &&
    onRefreshMcpServers &&
    onMcpAuth &&
    (mcpLoading || (mcpServers && mcpServers.length > 0)),
  )
  const showAdvanced = Boolean(
    (showWorktree && isNewSession && onWorktreeEnabledChange) ||
    (showUltracode && onUltracodeEnabledChange) ||
    showMcp,
  )
  const selectedNames = new Set(selectedMcpServers ?? [])

  if (!showAdvanced) return null

  return (
    <section aria-labelledby="mobile-advanced-controls" className="flex flex-col gap-2">
      <h3 id="mobile-advanced-controls" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Advanced
      </h3>
      <div className="grid grid-cols-2 gap-2">
        {showWorktree && isNewSession && onWorktreeEnabledChange && (
          <MobileControl label="Isolation">
            <Button
              type="button"
              variant={worktreeEnabled ? "secondary" : "ghost"}
              aria-pressed={!!worktreeEnabled}
              onClick={() => onWorktreeEnabledChange(!worktreeEnabled)}
              className="h-10 justify-start"
            >
              <GitBranch data-icon="inline-start" />
              Worktree
            </Button>
          </MobileControl>
        )}

        {showUltracode && onUltracodeEnabledChange && (
          <MobileControl label="Workflow">
            <Button
              type="button"
              variant={ultracodeEnabled ? "secondary" : "ghost"}
              aria-pressed={!!ultracodeEnabled}
              onClick={() => changeAndApply(() => onUltracodeEnabledChange(!ultracodeEnabled))}
              className="h-10 justify-start"
            >
              <Zap data-icon="inline-start" className={cn(ultracodeEnabled && "fill-current")} />
              Ultracode
            </Button>
          </MobileControl>
        )}

        {showMcp && onToggleMcpServer && onRefreshMcpServers && onMcpAuth && (
          <MobileControl label="Connections" wide>
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                variant="ghost"
                onClick={onRefreshMcpServers}
                className="min-h-10 justify-start"
              >
                <RefreshCw data-icon="inline-start" className={cn(mcpLoading && "animate-spin")} />
                Refresh MCP status
              </Button>
              {(mcpServers ?? []).map((server) => {
                const selected = selectedNames.has(server.name)
                const connected = server.status === "connected"
                return (
                  <Button
                    key={server.name}
                    type="button"
                    variant="ghost"
                    aria-pressed={connected ? selected : undefined}
                    onClick={() => connected
                      ? changeAndApply(() => onToggleMcpServer(server.name))
                      : onMcpAuth(server.name)}
                    className="min-h-10 justify-start text-left"
                  >
                    <span className={cn(
                      "size-2 shrink-0 rounded-full",
                      connected && selected
                        ? "bg-success"
                        : connected ? "bg-muted-foreground" : "bg-warning",
                    )} />
                    <span className="min-w-0 flex-1 truncate">{server.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {connected ? (selected ? "On" : "Off") : "Connect"}
                    </span>
                  </Button>
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
  catalogOptions: readonly ModelOption[]
  mobileExtra?: ReactNode
}

export function MobileChatInputSettings({
  open,
  onOpenChange,
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
  const permissionOptions = getPermissionModeOptions(agentKind, autoModeAvailable)
  const permissionLabel = permissionOptions.find((option) => option.value === permissionMode)?.label
  const summary = [
    selectedModel ? friendlyModelName(selectedModel, catalogOptions) : resolvedDefaultName,
    effortOptions.find((option) => option.value === selectedEffort)?.label,
    permissionLabel,
  ].filter(Boolean).join(" · ")

  const changeMobilePermission = (nextMode: PermissionMode) => {
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
              className="ml-0.5 shrink-0 rounded-full text-muted-foreground"
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
                  size="icon-lg"
                  className="absolute right-2 top-2"
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
              <section aria-labelledby="mobile-goal-controls" className="flex flex-col gap-2 pt-1">
                <Separator className="mb-3" />
                <h3 id="mobile-goal-controls" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Long-running goal
                </h3>
                <div className="[&>*]:mx-0 [&>*]:mb-0 [&_button]:min-h-10">{mobileExtra}</div>
              </section>
            )}

            {!isNewSession && (
              <p className="text-xs text-muted-foreground">
                {capabilitiesFor(agentKind).settingsApply === "live"
                  ? "Changes apply live."
                  : "Changes apply on the next turn."}
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
