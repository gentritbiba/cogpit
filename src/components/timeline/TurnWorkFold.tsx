import { ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

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
    <Button
      type="button"
      variant="ghost"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        "group/fold h-auto min-h-8 w-full cursor-pointer justify-start gap-1.5 px-1 text-left text-xs font-normal text-muted-foreground",
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
    </Button>
  )
}
