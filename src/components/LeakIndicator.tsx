import { useEffect, useState } from "react"
import { Flame } from "lucide-react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useLeakMonitor } from "@/hooks/useLeakMonitor"
import { formatAge } from "@/lib/format"
import { cn } from "@/lib/utils"

/** How long a cleared indicator stays on screen before it hides itself. */
const CLEARED_VISIBLE_MS = 60_000

export function LeakIndicator({ onReview }: { onReview: () => void }) {
  const { leaks } = useLeakMonitor()
  const [pinned, setPinned] = useState(false)

  const hasLeaks = leaks.length > 0
  const totalCpu = leaks.reduce((sum, leak) => sum + leak.cpuPercent, 0)

  useEffect(() => {
    if (hasLeaks) {
      setPinned(true)
      return
    }
    const timer = window.setTimeout(() => setPinned(false), CLEARED_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [hasLeaks])

  if (!hasLeaks && !pinned) return null

  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          variant={hasLeaks ? "destructive" : "ghost"}
          size="icon-sm"
          aria-label={hasLeaks
            ? `Review ${leaks.length} flagged ${leaks.length === 1 ? "process" : "processes"}`
            : "Leak monitor. No flagged processes"}
          onClick={onReview}
          className={cn("relative rounded-md", !hasLeaks && "text-muted-foreground")}
        />
      }>
        <Flame data-icon="inline-start" />
        {hasLeaks && (
          <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-background px-1 font-mono text-[9px] leading-4 text-destructive tabular-nums">
            {leaks.length}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="left" className="p-3">
        {hasLeaks ? (
          <div className="flex min-w-56 flex-col gap-2">
            <div className="text-xs font-medium">
              Flagged processes · {totalCpu.toFixed(0)}% CPU
            </div>
            {leaks.slice(0, 6).map((leak) => (
              <div key={leak.pid} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-muted-foreground">{leak.label} · {formatAge(leak.ageSeconds)}</span>
                <span className="shrink-0 font-semibold text-destructive">{leak.cpuPercent.toFixed(0)}%</span>
              </div>
            ))}
            {leaks.length > 6 && (
              <div className="text-xs text-muted-foreground">+{leaks.length - 6} more</div>
            )}
            <Separator />
            <div className="text-xs text-muted-foreground">
              Review ownership and stop individual processes
            </div>
          </div>
        ) : (
          <div className="flex min-w-48 flex-col gap-1">
            <div className="text-xs font-medium">Leak monitor</div>
            <div className="text-xs text-muted-foreground">
              No flagged processes. Click to open the power monitor.
            </div>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
