import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * The one row a settled turn shows in place of its work.
 *
 * Deliberately a hairline, not a card: it is a seam in the transcript, and the
 * eye should pass over it on the way to the answer unless the user is looking
 * for it.
 */
export function TurnWorkFold({
  label,
  expanded,
  onToggle,
  compact = false,
}: {
  label: string
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
        "group/fold flex w-full items-center gap-1.5 rounded text-left",
        "text-[11px] text-muted-foreground/55 hover:text-muted-foreground",
        "transition-colors",
        compact ? "py-1" : "py-1.5",
      )}
    >
      <ChevronRight
        className={cn(
          "size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
          expanded && "rotate-90",
        )}
      />
      <span className="tabular-nums">{label}</span>
      <span
        aria-hidden
        className="ml-1 h-px flex-1 bg-border/40 transition-colors group-hover/fold:bg-border/70"
      />
    </button>
  )
}
