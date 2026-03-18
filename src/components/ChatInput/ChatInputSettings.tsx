import { useState, useRef, useEffect, useCallback, memo } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, GitBranch, Plug, RefreshCw, Check, Bot, Code2 } from "lucide-react"
import { cn, EFFORT_OPTIONS, DEFAULT_EFFORT, getModelOptions, CLAUDE_MODEL_OPTIONS, CODEX_MODEL_OPTIONS } from "@/lib/utils"
import type { AgentKind } from "@/lib/sessionSource"

// ── Helpers ──────────────────────────────────────────────────────────────────

interface DropdownOption {
  value: string
  label: string
  /** Shown in the dropdown menu only (e.g. "Opus (default)") */
  menuLabel?: string
}

/** Extract a friendly model name from a model ID like "claude-opus-4-6" */
function friendlyModelName(modelId: string): string {
  const lower = modelId.toLowerCase()
  if (lower.includes("opus")) return "Opus"
  if (lower.includes("sonnet")) return "Sonnet"
  if (lower.includes("haiku")) return "Haiku"
  if (lower.startsWith("gpt-5.4-mini")) return "GPT-5.4 Mini"
  if (lower.startsWith("gpt-5.4")) return "GPT-5.4"
  if (lower.startsWith("gpt-5.3-codex")) return "GPT-5.3 Codex"
  if (lower.startsWith("gpt-5.2-codex")) return "GPT-5.2 Codex"
  return modelId
}

// ── Shared dropdown state (positioning + outside-click) ──────────────────────

interface DropdownState {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  triggerRef: React.RefObject<HTMLButtonElement | null>
  menuRef: React.RefObject<HTMLDivElement | null>
  menuPos: { top: number; left: number } | null
}

function useDropdownState(): DropdownState {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

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

  return { open, setOpen, triggerRef, menuRef, menuPos }
}

const MENU_OFFSET_STYLE = { transform: "translateY(-100%) translateY(-4px)" }

// ── Dropdown primitive (renders menu via portal to avoid clipping) ────────────

interface MiniDropdownProps {
  value: string
  /** Label shown on the trigger when no option matches */
  fallbackLabel: string
  options: readonly DropdownOption[]
  onChange: (value: string) => void
}

function MiniDropdown({ value, fallbackLabel, options, onChange }: MiniDropdownProps) {
  const { open, setOpen, triggerRef, menuRef, menuPos } = useDropdownState()

  const selectedLabel = options.find((o) => o.value === value)?.label ?? fallbackLabel

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          "text-muted-foreground hover:text-foreground hover:bg-white/5",
        )}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown className={cn("size-3 opacity-50 transition-transform", open && "rotate-180")} />
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] min-w-[130px] rounded-lg border border-border/50 bg-elevation-3 pt-1 pb-0 depth-high animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ top: menuPos.top, left: menuPos.left, ...MENU_OFFSET_STYLE }}
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => { onChange(opt.value); setOpen(false) }}
              className={cn(
                "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-[11px] transition-colors",
                opt.value === value
                  ? "text-foreground bg-white/5"
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5"
              )}
            >
              <span>{opt.menuLabel ?? opt.label}</span>
              {opt.value === value && (
                <span className="text-[9px] text-muted-foreground">active</span>
              )}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  )
}

// ── Provider + Model combined dropdown (new sessions only) ─────────────────────

interface ProviderModelDropdownProps {
  agentKind: AgentKind
  model: string
  activeModelId?: string
  onChange: (agentKind: AgentKind, model: string) => void
}

function ProviderModelDropdown({ agentKind, model, activeModelId, onChange }: ProviderModelDropdownProps) {
  const { open, setOpen, triggerRef, menuRef, menuPos } = useDropdownState()

  // Resolve display label for current selection
  const allOptions = agentKind === "claude" ? CLAUDE_MODEL_OPTIONS : CODEX_MODEL_OPTIONS
  const selectedOption = allOptions.find((o) => o.value === model)
  const resolvedDefault = agentKind === "claude"
    ? (activeModelId ? friendlyModelName(activeModelId) : "Opus")
    : "GPT-5.4"
  const triggerLabel = model === "" ? resolvedDefault : (selectedOption?.label ?? model)

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
          "text-muted-foreground hover:text-foreground hover:bg-white/5",
        )}
      >
        {agentKind === "claude"
          ? <Bot className="size-3 text-blue-400" />
          : <Code2 className="size-3 text-emerald-400" />
        }
        <span className="truncate">{triggerLabel}</span>
        <ChevronDown className={cn("size-3 opacity-50 transition-transform", open && "rotate-180")} />
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] min-w-[160px] rounded-lg border border-border/50 bg-elevation-3 py-1 depth-high animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ top: menuPos.top, left: menuPos.left, ...MENU_OFFSET_STYLE }}
        >
          {/* Claude Code section */}
          <div className="flex items-center gap-1.5 px-3 py-1.5">
            <Bot className="size-3 text-blue-400" />
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Claude Code</span>
          </div>
          {CLAUDE_MODEL_OPTIONS.map((opt) => {
            const isActive = agentKind === "claude" && model === opt.value
            const label = opt.value === "" ? `${resolvedDefault} (default)` : opt.label
            return (
              <button
                key={`claude:${opt.value}`}
                onClick={() => { onChange("claude", opt.value); setOpen(false) }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-[11px] transition-colors",
                  isActive ? "text-foreground bg-white/5" : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                )}
              >
                <span>{label}</span>
                {isActive && <span className="text-[9px] text-muted-foreground">active</span>}
              </button>
            )
          })}

          <div className="my-1 border-t border-border/30" />

          {/* Codex section */}
          <div className="flex items-center gap-1.5 px-3 py-1.5">
            <Code2 className="size-3 text-emerald-400" />
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Codex</span>
          </div>
          {CODEX_MODEL_OPTIONS.map((opt) => {
            const isActive = agentKind === "codex" && model === opt.value
            const label = opt.value === "" ? "GPT-5.4 (default)" : opt.label
            return (
              <button
                key={`codex:${opt.value}`}
                onClick={() => { onChange("codex", opt.value); setOpen(false) }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-[11px] transition-colors",
                  isActive ? "text-foreground bg-white/5" : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                )}
              >
                <span>{label}</span>
                {isActive && <span className="text-[9px] text-muted-foreground">active</span>}
              </button>
            )
          })}
        </div>,
        document.body
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
  const { open, setOpen, triggerRef, menuRef, menuPos } = useDropdownState()

  const connectedCount = servers.filter(s => s.status === "connected").length
  const selectedCount = selected.length

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
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
          className="fixed z-[9999] min-w-[180px] rounded-lg border border-border/50 bg-elevation-3 py-1 depth-high animate-in fade-in-0 zoom-in-95 duration-100"
          style={{ top: menuPos.top, left: menuPos.left, ...MENU_OFFSET_STYLE }}
        >
          {/* Header with refresh */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">MCP Servers</span>
            <button
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
            const isSelected = selected.includes(server.name)

            if (!isConnected) {
              return (
                <div key={server.name} className="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground/50">
                  <button
                    onClick={() => { onAuth(server.name); setOpen(false) }}
                    className="flex items-center gap-2 flex-1 min-w-0 hover:bg-white/5 transition-colors rounded-sm -mx-1 px-1 py-0.5"
                  >
                    <span className="size-2 rounded-full bg-amber-500/60 shrink-0" />
                    <span className="truncate">{server.name}</span>
                    <span className="ml-auto text-[9px] text-amber-500/70 shrink-0">Needs auth</span>
                  </button>
                  <button
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

export interface ChatInputSettingsProps {
  agentKind?: AgentKind
  selectedModel: string
  onModelChange: (model: string) => void
  selectedEffort: string
  onEffortChange: (effort: string) => void
  isNewSession: boolean
  worktreeEnabled?: boolean
  onWorktreeEnabledChange?: (enabled: boolean) => void
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
  /** Called when user switches provider (new session only) */
  onAgentKindChange?: (kind: AgentKind) => void
}

export const ChatInputSettings = memo(function ChatInputSettings({
  agentKind = "claude",
  selectedModel,
  onModelChange,
  selectedEffort,
  onEffortChange,
  isNewSession,
  worktreeEnabled,
  onWorktreeEnabledChange,
  onApplySettings,
  activeModelId,
  mcpServers,
  selectedMcpServers,
  onToggleMcpServer,
  onRefreshMcpServers,
  mcpLoading,
  onMcpAuth,
  onAgentKindChange,
}: ChatInputSettingsProps) {
  // Use a ref to always have the latest onApplySettings without stale closures
  const applyRef = useRef(onApplySettings)
  applyRef.current = onApplySettings

  /** Apply a setting change and auto-apply to the active session if applicable. */
  const changeAndApply = useCallback((apply: () => void) => {
    apply()
    if (!isNewSession && applyRef.current) {
      setTimeout(() => applyRef.current?.(), 0)
    }
  }, [isNewSession])

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
  const resolvedDefaultName = agentKind === "codex"
    ? (activeModelId?.toLowerCase().startsWith("gpt-") ? friendlyModelName(activeModelId) : "GPT-5.4")
    : (activeModelId ? friendlyModelName(activeModelId) : "Opus")
  const modelOptions: readonly DropdownOption[] = getModelOptions(agentKind).map((opt) =>
    opt.value === ""
      ? { value: "", label: resolvedDefaultName, menuLabel: `${resolvedDefaultName} (default)` }
      : opt
  )
  const showWorktree = agentKind === "claude"

  return (
    <div className="flex items-center pb-2">
      <div className="w-full flex items-center gap-0.5 flex-wrap">
        {/* Model / Provider+Model */}
        {isNewSession && onAgentKindChange ? (
          <ProviderModelDropdown
            agentKind={agentKind}
            model={selectedModel}
            activeModelId={activeModelId}
            onChange={(kind, mdl) => {
              onAgentKindChange(kind)
              handleModelChange(mdl)
            }}
          />
        ) : (
          <MiniDropdown
            value={selectedModel}
            fallbackLabel="Model"
            options={modelOptions}
            onChange={handleModelChange}
          />
        )}

        <span className="text-border/60 text-[10px] select-none">/</span>
        <MiniDropdown
          value={selectedEffort || DEFAULT_EFFORT}
          fallbackLabel="Effort"
          options={EFFORT_OPTIONS}
          onChange={handleEffortChange}
        />

        {/* Worktree toggle — new session only */}
        {showWorktree && isNewSession && onWorktreeEnabledChange && (
          <>
            <span className="text-border/60 text-[10px] select-none">/</span>
            <button
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

      </div>
    </div>
  )
})
