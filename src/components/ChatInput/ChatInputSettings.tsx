import { useState, useRef, useEffect, useCallback, memo } from "react"
import { createPortal } from "react-dom"
import { Bot, Check, ChevronDown, Code2, GitBranch, Plug, RefreshCw, Shield, Zap } from "lucide-react"
import {
  cn,
  getEffortOptions,
  getFastServiceTierOption,
  normalizeEffortForAgent,
  supportsAutoPermissionMode,
  type ModelOption,
} from "@/lib/utils"
import { useModelOptions } from "@/hooks/useModelOptions"
import type { AgentKind } from "@/lib/sessionSource"
import type { PermissionMode } from "@/lib/permissions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// ── Helpers ──────────────────────────────────────────────────────────────────

interface DropdownOption {
  value: string
  label: string
  /** Shown in the dropdown menu only (e.g. "Opus (default)") */
  menuLabel?: string
  description?: string
}

/** Extract a friendly model name from a model ID like "claude-opus-4-6" */
function friendlyModelName(modelId: string, options?: readonly ModelOption[]): string {
  // Exact match against the live model catalog wins (e.g. "gpt-5.6-sol" → "GPT-5.6 Sol")
  const match = options?.find((opt) => opt.value !== "" && opt.value === modelId)
  if (match) return match.label

  const lower = modelId.toLowerCase()
  if (lower.includes("opus")) return "Opus"
  if (lower.includes("sonnet")) return "Sonnet"
  if (lower.includes("haiku")) return "Haiku"
  if (lower.includes("fable")) return "Fable"
  if (lower.startsWith("gpt-")) {
    // "gpt-5.6-sol" → "GPT-5.6 Sol", "gpt-5.4-mini" → "GPT-5.4 Mini"
    const [version, ...rest] = lower.slice(4).split("-")
    const suffix = rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
    return `GPT-${version}${suffix ? ` ${suffix}` : ""}`
  }
  return modelId
}

// ── Shared dropdown state (positioning + outside-click) ──────────────────────

interface DropdownState {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  triggerRef: React.RefObject<HTMLButtonElement | null>
  menuRef: React.RefObject<HTMLDivElement | null>
  menuPos: { top: number; left: number } | null
  closeAndFocus: () => void
}

function useDropdownState(): DropdownState {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const closeAndFocus = useCallback(() => {
    setOpen(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setMenuPos({ top: rect.top, left: rect.left })
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  useEffect(() => {
    if (!open || !menuPos) return

    const focusFirstItem = requestAnimationFrame(() => {
      const menu = menuRef.current
      const selected = menu?.querySelector<HTMLElement>(
        '[role^="menuitem"][aria-checked="true"]:not([disabled])',
      )
      const first = menu?.querySelector<HTMLElement>(
        '[role^="menuitem"]:not([disabled])',
      )
      ;(selected ?? first)?.focus()
    })

    function handleKeyDown(e: KeyboardEvent) {
      const menu = menuRef.current
      if (!menu) return
      const items = Array.from(
        menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'),
      )
      if (items.length === 0) return

      if (e.key === "Escape") {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
        return
      }
      if (e.key === "Tab") {
        setOpen(false)
        return
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return

      e.preventDefault()
      const current = items.indexOf(document.activeElement as HTMLElement)
      const next = e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : e.key === "ArrowDown"
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length
      items[next]?.focus()
    }

    document.addEventListener("keydown", handleKeyDown)
    return () => {
      cancelAnimationFrame(focusFirstItem)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [open, menuPos])

  return { open, setOpen, triggerRef, menuRef, menuPos, closeAndFocus }
}

const MENU_OFFSET_STYLE = { transform: "translateY(-100%) translateY(-4px)" }

// ── Dropdown primitive (renders menu via portal to avoid clipping) ────────────

interface MiniDropdownProps {
  value: string
  /** Label shown on the trigger when no option matches */
  fallbackLabel: string
  options: readonly DropdownOption[]
  onChange: (value: string) => void
  /** When set, the trigger is shown but locked (e.g. effort pinned by ultracode) */
  disabled?: boolean
  /** Tooltip shown on hover (useful to explain why a control is locked) */
  title?: string
  ariaLabel: string
}

function MiniDropdown({ value, fallbackLabel, options, onChange, disabled, title, ariaLabel }: MiniDropdownProps) {
  const { open, setOpen, triggerRef, menuRef, menuPos, closeAndFocus } = useDropdownState()

  const selectedLabel = options.find((o) => o.value === value)?.label ?? fallbackLabel

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => { if (!disabled) setOpen(!open) }}
        disabled={disabled}
        title={title}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          disabled
            ? "text-muted-foreground/50 cursor-not-allowed"
            : "text-muted-foreground hover:text-foreground hover:bg-white/5",
        )}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown className={cn("size-3 opacity-50 transition-transform", open && "rotate-180")} />
      </button>

      {!disabled && open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={ariaLabel}
          className="fixed z-[9999] min-w-[130px] rounded-lg border border-border/50 bg-elevation-3 pt-1 pb-0 depth-high animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ top: menuPos.top, left: menuPos.left, ...MENU_OFFSET_STYLE }}
        >
          {options.map((opt) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={opt.value === value}
              key={opt.value}
              onClick={() => { onChange(opt.value); closeAndFocus() }}
              className={cn(
                "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-[11px] transition-colors",
                opt.value === value
                  ? "text-foreground bg-white/5"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
            >
              <span className="flex min-w-0 flex-col items-start">
                <span>{opt.menuLabel ?? opt.label}</span>
                {opt.description && (
                  <span className="max-w-64 truncate text-[9px] font-normal text-muted-foreground/70">
                    {opt.description}
                  </span>
                )}
              </span>
              {opt.value === value && <Check className="size-3 shrink-0 text-primary" />}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

// ── Provider + Model combined dropdown (new sessions only) ─────────────────────

const AGENT_OPTIONS: Array<{ value: AgentKind; label: string; Icon: typeof Bot }> = [
  { value: "claude", label: "Claude", Icon: Bot },
  { value: "codex", label: "Codex", Icon: Code2 },
]

interface AgentModelDropdownProps {
  agentKind: AgentKind
  onAgentKindChange: (agentKind: AgentKind) => void
  value: string
  fallbackLabel: string
  options: readonly DropdownOption[]
  onChange: (value: string) => void
}

function AgentModelDropdown({
  agentKind,
  onAgentKindChange,
  value,
  fallbackLabel,
  options,
  onChange,
}: AgentModelDropdownProps) {
  const { open, setOpen, triggerRef, menuRef, menuPos, closeAndFocus } = useDropdownState()

  const agentLabel = agentKind === "codex" ? "Codex" : "Claude"
  const selectedLabel = options.find((o) => o.value === value)?.label ?? fallbackLabel

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          "text-muted-foreground hover:text-foreground hover:bg-white/5",
        )}
      >
        <span className="truncate">{`${agentLabel} / ${selectedLabel}`}</span>
        <ChevronDown className={cn("size-3 opacity-50 transition-transform", open && "rotate-180")} />
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Agent and model"
          className="fixed z-[9999] min-w-[220px] rounded-lg border border-border/50 bg-elevation-3 py-1 depth-high animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ top: menuPos.top, left: menuPos.left, ...MENU_OFFSET_STYLE }}
        >
          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Agent
          </div>
          <div role="group" aria-label="Agent">
          {AGENT_OPTIONS.map((option) => {
            const Icon = option.Icon
            const isActive = option.value === agentKind
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                key={option.value}
                onClick={() => { onAgentKindChange(option.value); closeAndFocus() }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-[11px] transition-colors",
                  isActive
                    ? "bg-white/5 text-foreground"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                <span>{option.label}</span>
                {isActive && <Check className="ml-auto size-3 text-emerald-500" />}
              </button>
            )
          })}
          </div>

          <div className="my-1 border-t border-border/30" />
          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Model
          </div>
          <div role="group" aria-label="Model">
          {options.map((opt) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={opt.value === value}
              key={opt.value}
              onClick={() => { onChange(opt.value); closeAndFocus() }}
              className={cn(
                "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-[11px] transition-colors",
                opt.value === value
                  ? "bg-white/5 text-foreground"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              )}
            >
              <span className="flex min-w-0 flex-col items-start">
                <span>{opt.menuLabel ?? opt.label}</span>
                {opt.description && (
                  <span className="max-w-72 truncate text-[9px] font-normal text-muted-foreground/70">
                    {opt.description}
                  </span>
                )}
              </span>
              {opt.value === value && <Check className="size-3 shrink-0 text-primary" />}
            </button>
          ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

// ── MCP multi-select dropdown ─────────────────────────────────────────────────

interface McpDropdownProps {
  servers: Array<{ name: string; status: "connected" | "needs_auth" | "error" }>
  selected: string[]
  onToggle: (name: string) => void
  onRefresh: () => void
  loading: boolean
  onAuth: (name: string) => void
}

function McpDropdown({ servers, selected, onToggle, onRefresh, loading, onAuth }: McpDropdownProps) {
  const { open, setOpen, triggerRef, menuRef, menuPos, closeAndFocus } = useDropdownState()

  const connectedCount = servers.filter(s => s.status === "connected").length
  const selectedCount = selected.length
  const selectedNames = new Set(selected)

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          "text-muted-foreground hover:text-foreground hover:bg-white/5",
        )}
      >
        <Plug className="size-3" />
        <span className="truncate">
          {loading && servers.length === 0 ? "MCPs" : `MCPs ${selectedCount}/${connectedCount}`}
        </span>
        {loading && servers.length === 0
          ? <RefreshCw className="size-3 opacity-50 animate-spin" />
          : <ChevronDown className={cn("size-3 opacity-50 transition-transform", open && "rotate-180")} />
        }
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="MCP servers"
          className="fixed z-[9999] min-w-[180px] rounded-lg border border-border/50 bg-elevation-3 py-1 depth-high animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ top: menuPos.top, left: menuPos.left, ...MENU_OFFSET_STYLE }}
        >
          {/* Header with refresh */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">MCP Servers</span>
            <button
              type="button"
              aria-label="Refresh MCP server status"
              onClick={(e) => { e.stopPropagation(); onRefresh() }}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Refresh status"
            >
              <RefreshCw className={cn("size-3", loading && "animate-spin")} />
            </button>
          </div>

          {servers.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              {loading ? "Loading..." : "No MCP servers configured"}
            </div>
          )}

          {servers.map((server) => {
            const isConnected = server.status === "connected"
            const isSelected = selectedNames.has(server.name)

            if (!isConnected) {
              return (
                <div key={server.name} className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground/50">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { onAuth(server.name); closeAndFocus() }}
                    className="flex items-center gap-2 flex-1 min-w-0 hover:bg-white/5 transition-colors rounded-sm -mx-1 px-1 py-0.5"
                  >
                    <span className="size-2 rounded-full bg-amber-500/60 shrink-0" />
                    <span className="truncate">{server.name}</span>
                    <span className="ml-auto text-[9px] text-amber-500/70 shrink-0">Needs auth</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`Refresh ${server.name} status`}
                    onClick={(e) => { e.stopPropagation(); onRefresh() }}
                    className="text-muted-foreground/50 hover:text-foreground transition-colors shrink-0 p-0.5 rounded-sm hover:bg-white/5"
                    title="Refresh status"
                  >
                    <RefreshCw className={cn("size-3", loading && "animate-spin")} />
                  </button>
                </div>
              )
            }

            return (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={isSelected}
                key={server.name}
                onClick={() => onToggle(server.name)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-[11px] transition-colors",
                  isSelected
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                  "hover:bg-white/5",
                )}
              >
                <span className={cn("size-2 rounded-full shrink-0", isSelected ? "bg-emerald-500" : "bg-zinc-600")} />
                <span className="truncate">{server.name}</span>
                {isSelected && <Check className="size-3 ml-auto text-emerald-500" />}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

// ── Permission mode dropdown ─────────────────────────────────────────────────

const CLAUDE_PERMISSION_MODES: Array<{ value: PermissionMode; label: string; description: string; color: string }> = [
  { value: "default", label: "Ask", description: "Ask before sensitive actions", color: "text-blue-400" },
  { value: "plan", label: "Plan", description: "Read and plan without changing files", color: "text-purple-400" },
  { value: "acceptEdits", label: "Accept Edits", description: "Allow file edits; ask for other actions", color: "text-green-400" },
  { value: "auto", label: "Auto", description: "Run autonomously with classifier safeguards", color: "text-cyan-400" },
  { value: "dontAsk", label: "Don't Ask", description: "Deny actions that need approval", color: "text-amber-400" },
  { value: "bypassPermissions", label: "Full access", description: "Skip permission checks", color: "text-red-400" },
]

const CODEX_PERMISSION_MODES: Array<{ value: PermissionMode; label: string; description: string; color: string }> = [
  { value: "default", label: "Workspace", description: "Write inside the project sandbox", color: "text-blue-400" },
  { value: "plan", label: "Read only", description: "Inspect and plan without writing", color: "text-purple-400" },
  { value: "bypassPermissions", label: "Full access", description: "No sandbox or approval checks", color: "text-red-400" },
]

interface PermissionDropdownProps {
  agentKind: AgentKind
  mode: PermissionMode
  onChange: (mode: PermissionMode) => void
  autoAvailable?: boolean
}

function PermissionDropdown({ agentKind, mode, onChange, autoAvailable = false }: PermissionDropdownProps) {
  const { open, setOpen, triggerRef, menuRef, menuPos, closeAndFocus } = useDropdownState()
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)

  const options = agentKind === "codex"
    ? CODEX_PERMISSION_MODES
    : CLAUDE_PERMISSION_MODES.filter((option) => option.value !== "auto" || autoAvailable)
  const current = options.find((m) => m.value === mode) ?? options[0]

  const chooseMode = (nextMode: PermissionMode) => {
    if (nextMode === "bypassPermissions" && mode !== "bypassPermissions") {
      setConfirmingFullAccess(true)
      setOpen(false)
      return
    }
    onChange(nextMode)
    closeAndFocus()
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => {
          const nextOpen = !open
          setOpen(nextOpen)
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          current.color,
          "hover:bg-white/5",
        )}
      >
        <Shield className="size-3" />
        <span className="truncate">{current.label}</span>
        <ChevronDown className={cn("size-3 opacity-50 transition-transform", open && "rotate-180")} />
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Access policy"
          className="fixed z-[9999] min-w-[150px] rounded-lg border border-border/50 bg-elevation-3 py-1 depth-high animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ top: menuPos.top, left: menuPos.left, ...MENU_OFFSET_STYLE }}
        >
          <div className="px-3 py-1.5 border-b border-border/30">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Permissions</span>
          </div>
          {options.map((opt) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={opt.value === mode}
              key={opt.value}
              onClick={() => chooseMode(opt.value)}
              className={cn(
                "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-[11px] transition-colors",
                opt.value === mode
                  ? cn("bg-white/5", opt.color)
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5",
              )}
            >
              <span className="flex min-w-0 flex-col items-start">
                <span>
                  {opt.label}
                </span>
                <span className="max-w-64 truncate text-[9px] font-normal text-muted-foreground/70">
                  {opt.description}
                </span>
              </span>
              {opt.value === mode && (
                <span className="text-[9px] text-muted-foreground">active</span>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
      <Dialog open={confirmingFullAccess} onOpenChange={setConfirmingFullAccess}>
        <DialogContent className="border-red-900/40 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red-300">Enable full access?</DialogTitle>
            <DialogDescription>
              Cogpit will run {agentKind === "codex" ? "Codex" : "Claude"} with no sandbox or approval checks. Commands can read or change anything your user account can access.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmingFullAccess(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-red-600 text-white hover:bg-red-500"
              onClick={() => {
                onChange("bypassPermissions")
                setConfirmingFullAccess(false)
                requestAnimationFrame(() => triggerRef.current?.focus())
              }}
            >
              Enable full access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

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
}: ChatInputSettingsProps) {
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

  // Build model options with resolved "Default" label — scoped to current agentKind
  // so Codex sessions never show a Claude model name and vice versa
  const catalogOptions = useModelOptions(agentKind)
  // First non-empty option is the provider's current default model
  const providerDefaultLabel = catalogOptions.find((opt) => opt.value !== "")?.label
  const resolvedDefaultName = agentKind === "codex"
    ? (activeModelId?.toLowerCase().startsWith("gpt-")
        ? friendlyModelName(activeModelId, catalogOptions)
        : providerDefaultLabel ?? "GPT")
    : (activeModelId ? friendlyModelName(activeModelId, catalogOptions) : "Opus")
  const modelOptions: readonly DropdownOption[] = catalogOptions.map((opt) => {
    const description = [opt.description, opt.availabilityMessage].filter(Boolean).join(" · ") || undefined
    return opt.value === ""
      ? { ...opt, description, value: "", label: resolvedDefaultName, menuLabel: `${resolvedDefaultName} (default)` }
      : { ...opt, description }
  })
  const effortOptions = getEffortOptions(agentKind, selectedModel)
  const fastTier = getFastServiceTierOption(agentKind, selectedModel)
  const autoModeAvailable = supportsAutoPermissionMode(agentKind, selectedModel)
  const showWorktree = agentKind === "claude"

  return (
    <div className="flex items-center pb-2">
      <div className="w-full flex items-center gap-0.5 flex-wrap">
        {/* Model */}
        {onAgentKindChange
          ? (
            <AgentModelDropdown
              agentKind={agentKind}
              onAgentKindChange={onAgentKindChange}
              value={selectedModel}
              fallbackLabel={resolvedDefaultName}
              options={modelOptions}
              onChange={handleModelChange}
            />
          )
          : (
            <MiniDropdown
              value={selectedModel}
              fallbackLabel="Model"
              ariaLabel="Model"
              options={modelOptions}
              onChange={handleModelChange}
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
              onChange={handleEffortChange}
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

        {/* Access policy */}
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

        {/* Worktree toggle — new session only */}
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
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
            >
              <GitBranch className="size-3" />
              Worktree
            </button>
          </>
        )}

        {/* Ultracode toggle — claude only, new session only */}
        {showWorktree && isNewSession && onUltracodeEnabledChange && (
          <>
            <span className="text-border/60 text-[10px] select-none">/</span>
            <button
              type="button"
              aria-pressed={!!ultracodeEnabled}
              onClick={() => onUltracodeEnabledChange(!ultracodeEnabled)}
              title="Ultracode: XHigh effort + standing multi-agent workflow orchestration"
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                ultracodeEnabled
                  ? "text-amber-400"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
            >
              <Zap className={cn("size-3", ultracodeEnabled && "fill-amber-400")} />
              Ultracode
            </button>
          </>
        )}

        {/* MCP server selector — show when servers exist or still loading */}
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
})
