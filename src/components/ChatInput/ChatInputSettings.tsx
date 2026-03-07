import { useState, useRef, useEffect, useCallback, memo } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, GitBranch } from "lucide-react"
import { cn } from "@/lib/utils"
import { MODEL_OPTIONS, EFFORT_OPTIONS, DEFAULT_EFFORT } from "@/lib/utils"

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
  return modelId
}

// ── Dropdown primitive (renders menu via portal to avoid clipping) ────────────

interface MiniDropdownProps {
  value: string
  /** Label shown on the trigger when no option matches */
  fallbackLabel: string
  options: readonly DropdownOption[]
  onChange: (value: string) => void
}

function MiniDropdown({ value, fallbackLabel, options, onChange }: MiniDropdownProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)

  // Position the menu above the trigger using fixed positioning
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setMenuPos({ top: rect.top, left: rect.left })
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

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
          style={{ top: menuPos.top, left: menuPos.left, transform: "translateY(-100%) translateY(-4px)" }}
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

// ── Main Component ───────────────────────────────────────────────────────────

export interface ChatInputSettingsProps {
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
}

export const ChatInputSettings = memo(function ChatInputSettings({
  selectedModel,
  onModelChange,
  selectedEffort,
  onEffortChange,
  isNewSession,
  worktreeEnabled,
  onWorktreeEnabledChange,
  onApplySettings,
  activeModelId,
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

  // Build model options with resolved "Default" label
  const resolvedDefaultName = activeModelId ? friendlyModelName(activeModelId) : "Opus"
  const modelOptions: readonly DropdownOption[] = MODEL_OPTIONS.map((opt) =>
    opt.value === ""
      ? { value: "", label: resolvedDefaultName, menuLabel: `${resolvedDefaultName} (default)` }
      : opt
  )

  return (
    <div className="flex items-center pb-2">
      <div className="w-full flex items-center gap-0.5 flex-wrap">
        {/* Model */}
        <MiniDropdown
          value={selectedModel}
          fallbackLabel="Model"
          options={modelOptions}
          onChange={handleModelChange}
        />

        <span className="text-border/60 text-[10px] select-none">/</span>

        {/* Thinking Effort */}
        <MiniDropdown
          value={selectedEffort || DEFAULT_EFFORT}
          fallbackLabel="Effort"
          options={EFFORT_OPTIONS}
          onChange={handleEffortChange}
        />

        {/* Worktree toggle — new session only */}
        {isNewSession && onWorktreeEnabledChange && (
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

      </div>
    </div>
  )
})
