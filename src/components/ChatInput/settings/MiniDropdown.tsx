import { createPortal } from "react-dom"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { DropdownOptionItem } from "./DropdownOptionItem"
import type { DropdownOption } from "./types"
import { MENU_OFFSET_STYLE, useDropdownState } from "./useDropdownState"

interface MiniDropdownProps {
  value: string
  /** Label shown on the trigger when no option matches. */
  fallbackLabel: string
  options: readonly DropdownOption[]
  onChange: (value: string) => void
  /** When set, the trigger is shown but locked (e.g. effort pinned by ultracode). */
  disabled?: boolean
  /** Tooltip shown on hover (useful to explain why a control is locked). */
  title?: string
  ariaLabel: string
}

export function MiniDropdown({
  value,
  fallbackLabel,
  options,
  onChange,
  disabled,
  title,
  ariaLabel,
}: MiniDropdownProps) {
  const { open, setOpen, triggerRef, menuRef, menuPos, closeAndFocus } = useDropdownState()
  const selectedLabel = options.find((option) => option.value === value)?.label ?? fallbackLabel

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
          {options.map((option) => (
            <DropdownOptionItem
              key={option.value}
              option={option}
              selected={option.value === value}
              onSelect={() => { onChange(option.value); closeAndFocus() }}
            />
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
