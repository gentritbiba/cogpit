import type { ComponentProps, ComponentType, ReactNode } from "react"
import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { PopoverContent } from "@/components/ui/popover"

/**
 * Where a composer picker opens. New-session composers sit mid-page with room
 * below; live-session composers hug the bottom edge, so their pickers open up.
 */
export type PickerSide = "top" | "bottom"

export function pickerSideFor(isNewSession: boolean): PickerSide {
  return isNewSession ? "bottom" : "top"
}

/** The chip every composer picker hangs off: ghost, compact, chevron at the end. */
export function PickerChip({ className, children, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={cn("max-w-72 data-popup-open:bg-accent data-popup-open:text-accent-foreground", className)}
      {...props}
    >
      {children}
      <ChevronDown data-icon="inline-end" className="opacity-60" />
    </Button>
  )
}

interface PickerPanelProps extends Omit<ComponentProps<typeof PopoverContent>, "side" | "collisionAvoidance"> {
  side: PickerSide
}

/**
 * The panel keeps its side and shrinks to the space there rather than
 * flipping: the direction is the point, and every list inside can scroll.
 */
export function PickerPanel({ side, align = "start", className, ...props }: PickerPanelProps) {
  return (
    <PopoverContent
      side={side}
      align={align}
      collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
      className={cn("flex flex-col overflow-hidden p-0", className)}
      {...props}
    />
  )
}

export function PickerSectionLabel({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground", className)}
      {...props}
    />
  )
}

interface PickerListProps<Value extends string> {
  value: Value
  onValueChange: (value: Value) => void
  className?: string
  children: ReactNode
  "aria-label"?: string
  "aria-labelledby"?: string
}

/** A single-choice list; arrow keys move between rows, a click or Space picks one. */
export function PickerList<Value extends string>({ value, onValueChange, className, children, ...aria }: PickerListProps<Value>) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onValueChange(next as Value)}
      className={cn("flex flex-col gap-px", className)}
      {...aria}
    >
      {children}
    </RadioGroup>
  )
}

/** The shared shape of every row inside a picker panel. */
export const pickerRowClass =
  "flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-colors duration-100 hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/40"

interface PickerOptionProps {
  value: string
  title: string
  description?: string
  icon?: ComponentType<{ className?: string }>
  disabled?: boolean
}

export function PickerOption({ value, title, description, icon: Icon, disabled }: PickerOptionProps) {
  return (
    <Radio.Root
      value={value}
      disabled={disabled}
      className={cn(
        pickerRowClass,
        "group/option data-checked:bg-accent data-checked:text-accent-foreground data-disabled:cursor-not-allowed data-disabled:opacity-40 data-disabled:hover:bg-transparent",
      )}
    >
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground group-data-checked/option:text-foreground" />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate leading-5 group-data-checked/option:font-medium">{title}</span>
        {description && (
          <span className="truncate text-xs leading-4 text-muted-foreground" title={description}>{description}</span>
        )}
      </span>
      <Radio.Indicator
        keepMounted
        className="shrink-0 text-foreground opacity-0 transition-opacity duration-100 data-checked:opacity-100"
      >
        <Check className="size-4" />
      </Radio.Indicator>
    </Radio.Root>
  )
}
