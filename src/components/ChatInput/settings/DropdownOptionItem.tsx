import { DropdownMenuRadioItem } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { DropdownOption } from "./types"

interface DropdownOptionItemProps {
  option: DropdownOption
  descriptionWidth?: "max-w-64" | "max-w-72"
}

export function DropdownOptionItem({
  option,
  descriptionWidth = "max-w-64",
}: DropdownOptionItemProps) {
  return (
    <DropdownMenuRadioItem value={option.value} className="items-start py-2">
      <span className="flex min-w-0 flex-col items-start">
        <span>{option.menuLabel ?? option.label}</span>
        {option.description && (
          <span className={cn(descriptionWidth, "truncate text-xs font-normal text-muted-foreground")}>
            {option.description}
          </span>
        )}
      </span>
    </DropdownMenuRadioItem>
  )
}
