import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import type { DropdownOption } from "./types"

interface DropdownOptionItemProps {
  option: DropdownOption
  selected: boolean
  onSelect: () => void
  descriptionWidth?: "max-w-64" | "max-w-72"
}

export function DropdownOptionItem({
  option,
  selected,
  onSelect,
  descriptionWidth = "max-w-64",
}: DropdownOptionItemProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-[11px] transition-colors",
        selected
          ? "bg-white/5 text-foreground"
          : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
      )}
    >
      <span className="flex min-w-0 flex-col items-start">
        <span>{option.menuLabel ?? option.label}</span>
        {option.description && (
          <span className={cn(
            descriptionWidth,
            "truncate text-[9px] font-normal text-muted-foreground/70",
          )}>
            {option.description}
          </span>
        )}
      </span>
      {selected && <Check className="size-3 shrink-0 text-primary" />}
    </button>
  )
}
