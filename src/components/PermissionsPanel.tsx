import { Shield, Check } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  type PermissionsConfig,
  type PermissionMode,
  KNOWN_TOOLS,
} from "@/lib/permissions"

const MODE_OPTIONS: { value: PermissionMode; label: string; color: string }[] = [
  { value: "bypassPermissions", label: "YOLO", color: "border-red-500 text-red-400 bg-red-500/10" },
  { value: "default", label: "Default", color: "border-blue-500 text-blue-400 bg-blue-500/10" },
  { value: "plan", label: "Plan", color: "border-purple-500 text-purple-400 bg-purple-500/10" },
  { value: "acceptEdits", label: "Accept Edits", color: "border-green-500 text-green-400 bg-green-500/10" },
  { value: "dontAsk", label: "Don't Ask", color: "border-amber-500 text-amber-400 bg-amber-500/10" },
  { value: "delegate", label: "Delegate", color: "border-cyan-500 text-cyan-400 bg-cyan-500/10" },
]

type ToolState = "allowed" | "blocked" | "none"

interface PermissionsPanelProps {
  config: PermissionsConfig
  hasPendingChanges: boolean
  onSetMode: (mode: PermissionMode) => void
  onToggleAllowed: (tool: string) => void
  onToggleDisallowed: (tool: string) => void
  onReset: () => void
}

function ToolAccessGrid({
  allowedTools,
  disallowedTools,
  onToggleAllowed,
  onToggleDisallowed,
}: {
  allowedTools: string[]
  disallowedTools: string[]
  onToggleAllowed: (tool: string) => void
  onToggleDisallowed: (tool: string) => void
}) {
  function getState(tool: string): ToolState {
    if (allowedTools.includes(tool)) return "allowed"
    if (disallowedTools.includes(tool)) return "blocked"
    return "none"
  }

  function handleLeft(tool: string) {
    const state = getState(tool)
    if (state === "blocked") onToggleDisallowed(tool) // remove block first
    onToggleAllowed(tool) // toggle allow
  }

  function handleRight(tool: string, e: React.MouseEvent) {
    e.preventDefault()
    const state = getState(tool)
    if (state === "allowed") onToggleAllowed(tool) // remove allow first
    onToggleDisallowed(tool) // toggle block
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Tool Access
        </span>
        <span className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
          <span className="inline-block size-1.5 rounded-sm bg-green-500" /> L-click allow
          <span className="inline-block size-1.5 rounded-sm bg-red-500" /> R-click block
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        {KNOWN_TOOLS.map((tool) => {
          const state = getState(tool)
          return (
            <button
              key={tool}
              onClick={() => handleLeft(tool)}
              onContextMenu={(e) => handleRight(tool, e)}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition-all",
                state === "allowed"
                  ? "border-green-800 text-green-400 bg-green-500/10"
                  : state === "blocked"
                    ? "border-red-800 text-red-400 bg-red-500/10"
                    : "border-border text-muted-foreground elevation-1 hover:border-border hover:text-foreground"
              )}
            >
              <span
                className={cn(
                  "flex size-3 shrink-0 items-center justify-center rounded-[3px] border transition-colors",
                  state === "allowed"
                    ? "border-green-500 bg-green-500"
                    : state === "blocked"
                      ? "border-red-500 bg-red-500"
                      : "border-border bg-transparent"
                )}
              >
                {state !== "none" && <Check className="size-2 text-white" strokeWidth={3} />}
              </span>
              {tool}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function PermissionsPanel({
  config,
  hasPendingChanges,
  onSetMode,
  onToggleAllowed,
  onToggleDisallowed,
  onReset,
}: PermissionsPanelProps) {
  return (
    <section>
      <h3 className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span className="h-3.5 w-0.5 rounded-full bg-blue-500/40" />
        <Shield className="size-3" />
        Permissions
        {hasPendingChanges && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-auto flex items-center gap-1 text-[10px] font-normal normal-case text-amber-400 cursor-help">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
                </span>
                pending
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[200px] text-xs">
              Applies on next message send. The current session won't be interrupted.
            </TooltipContent>
          </Tooltip>
        )}
      </h3>

      {/* Mode grid */}
      <div className="grid grid-cols-3 gap-1">
        {MODE_OPTIONS.map((opt) => {
          const isSelected = config.mode === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => onSetMode(opt.value)}
              className={cn(
                "rounded-md border px-2 py-1.5 text-[10px] font-medium transition-all",
                isSelected
                  ? opt.color
                  : "border-border text-muted-foreground hover:border-border hover:text-foreground elevation-1"
              )}
            >
              {opt.label}
            </button>
          )
        })}
      </div>

      {/* Tool access — hidden in YOLO mode */}
      {config.mode !== "bypassPermissions" && (
        <div className="mt-3">
          <ToolAccessGrid
            allowedTools={config.allowedTools}
            disallowedTools={config.disallowedTools}
            onToggleAllowed={onToggleAllowed}
            onToggleDisallowed={onToggleDisallowed}
          />
        </div>
      )}

      {/* Reset link */}
      {config.mode !== "bypassPermissions" && (
        <button
          onClick={onReset}
          className="mt-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Reset to default (YOLO)
        </button>
      )}
    </section>
  )
}
