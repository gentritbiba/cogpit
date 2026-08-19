import { ChevronDown } from "lucide-react"
import { useId } from "react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DropdownOptionItem } from "./DropdownOptionItem"
import type { DropdownOption } from "./types"

interface MiniDropdownProps {
  value: string
  fallbackLabel: string
  options: readonly DropdownOption[]
  onChange: (value: string) => void
  disabled?: boolean
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
  const selectedLabel = options.find((option) => option.value === value)?.label ?? fallbackLabel
  const menuLabelId = useId()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={<Button type="button" variant="ghost" size="xs" title={title} />}
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-labelledby={menuLabelId} className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel id={menuLabelId} className="sr-only">{ariaLabel}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
            {options.map((option) => (
              <DropdownOptionItem key={option.value} option={option} />
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
