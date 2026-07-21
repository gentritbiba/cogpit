import { createPortal } from "react-dom"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import type { AgentKind } from "@/lib/sessionSource"
import { AGENT_OPTIONS } from "./modelOptions"
import { DropdownOptionItem } from "./DropdownOptionItem"
import type { DropdownOption } from "./types"
import { MENU_OFFSET_STYLE, useDropdownState } from "./useDropdownState"

interface AgentModelDropdownProps {
  agentKind: AgentKind
  onAgentKindChange: (agentKind: AgentKind) => void
  value: string
  fallbackLabel: string
  options: readonly DropdownOption[]
  onChange: (value: string) => void
}

export function AgentModelDropdown({
  agentKind,
  onAgentKindChange,
  value,
  fallbackLabel,
  options,
  onChange,
}: AgentModelDropdownProps) {
  const { open, setOpen, triggerRef, menuRef, menuPos, closeAndFocus } = useDropdownState()
  const agentLabel = agentKind === "codex" ? "Codex" : "Claude"
  const selectedLabel = options.find((option) => option.value === value)?.label ?? fallbackLabel

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
            {options.map((option) => (
              <DropdownOptionItem
                key={option.value}
                option={option}
                selected={option.value === value}
                onSelect={() => { onChange(option.value); closeAndFocus() }}
                descriptionWidth="max-w-72"
              />
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
