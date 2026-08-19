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

/**
 * Top-bar leak monitor for agent processes (orphaned claude sessions, hot
 * headless browsers). Red when leaks are flagged, and clicking it then kills
 * all of them. A clean system shows nothing — the monitor keeps polling and
 * the power monitor still lists every process — but the indicator stays pinned
 * at zero for a minute after the last leak clears so a kill confirms itself.
 */
export function LeakIndicator() {
  const { leaks, killing, killLeaks, refresh } = useLeakMonitor()
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
          size="xs"
          aria-label={hasLeaks
            ? `Kill ${leaks.length} leaked agent ${leaks.length === 1 ? "process" : "processes"}`
            : "Leak monitor. No leaked agent processes"}
          onClick={() => void (hasLeaks ? killLeaks(leaks.map((leak) => leak.pid)) : refresh())}
          disabled={killing}
          className={cn("mr-1 font-mono", !hasLeaks && "text-muted-foreground")}
        />
      }>
        <Flame data-icon="inline-start" />
        <span className="tabular-nums">{killing ? "…" : leaks.length}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="p-3">
        {hasLeaks ? (
          <div className="flex min-w-56 flex-col gap-2">
            <div className="text-xs font-medium">
              Leaked agent processes · {totalCpu.toFixed(0)}% CPU
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
              Click to kill {leaks.length === 1 ? "it" : "all of them"}
            </div>
          </div>
        ) : (
          <div className="flex min-w-48 flex-col gap-1">
            <div className="text-xs font-medium">Leak monitor</div>
            <div className="text-xs text-muted-foreground">
              No leaked agent processes. Click to scan again.
            </div>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
