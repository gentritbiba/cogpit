import { createPortal } from "react-dom"
import { ChevronDown, Shield } from "lucide-react"
import { cn } from "@/lib/utils"
import type { PermissionMode } from "@/lib/permissions"
import type { AgentKind } from "@/lib/sessionSource"
import { getPermissionModeOptions } from "./permissionOptions"
import { MENU_OFFSET_STYLE, useDropdownState } from "./useDropdownState"

interface PermissionDropdownProps {
  agentKind: AgentKind
  mode: PermissionMode
  onChange: (mode: PermissionMode) => void
  autoAvailable?: boolean
}

export function PermissionDropdown({
  agentKind,
  mode,
  onChange,
  autoAvailable = false,
}: PermissionDropdownProps) {
  const { open, setOpen, triggerRef, menuRef, menuPos, closeAndFocus } = useDropdownState()
  const options = getPermissionModeOptions(agentKind, autoAvailable)
  const current = options.find((option) => option.value === mode) ?? options[0]

  const chooseMode = (nextMode: PermissionMode) => {
    onChange(nextMode)
    closeAndFocus()
  }

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
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Permissions
            </span>
          </div>
          {options.map((option) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={option.value === mode}
              key={option.value}
              onClick={() => chooseMode(option.value)}
              className={cn(
                "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-[11px] transition-colors",
                option.value === mode
                  ? cn("bg-white/5", option.color)
                  : "text-muted-foreground hover:text-foreground hover:bg-white/5",
              )}
            >
              <span className="flex min-w-0 flex-col items-start">
                <span>{option.label}</span>
                <span className="max-w-64 truncate text-[9px] font-normal text-muted-foreground/70">
                  {option.description}
                </span>
              </span>
              {option.value === mode && (
                <span className="text-[9px] text-muted-foreground">active</span>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
