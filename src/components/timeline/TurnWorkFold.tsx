import { ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export function TurnWorkFold({
  label,
  expanded,
  onToggle,
  compact = false,
}: {
  label: ReactNode
  expanded: boolean
  onToggle: () => void
  compact?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        "group/fold flex min-h-8 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left outline-none",
        "text-[11px] text-muted-foreground/55 hover:text-muted-foreground",
        "transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
        compact && "min-h-9",
      )}
    >
      <ChevronRight
        data-icon="inline-start"
        className={cn(
          "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
          expanded && "rotate-90",
        )}
      />
      <span className="tabular-nums">{label}</span>
      <span
        aria-hidden
        className="pointer-events-none ml-1 h-px flex-1 bg-border/40 transition-colors group-hover/fold:bg-border/70"
      />
    </button>
  )
}
