import { Flame } from "lucide-react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLeakMonitor } from "@/hooks/useLeakMonitor"
import { formatAge } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * Top-bar leak monitor for agent processes (orphaned claude sessions, hot
 * headless browsers). Muted with a zero count while the system is clean;
 * red when leaks are flagged, and clicking it then kills all of them.
 */
export function LeakIndicator() {
  const { leaks, killing, killLeaks, refresh } = useLeakMonitor()

  const hasLeaks = leaks.length > 0
  const totalCpu = leaks.reduce((sum, leak) => sum + leak.cpuPercent, 0)

  return (
    <Tooltip>
      <TooltipTrigger render={
        <button
          type="button"
          aria-label={hasLeaks
            ? `Kill ${leaks.length} leaked agent ${leaks.length === 1 ? "process" : "processes"}`
            : "Leak monitor — no leaked agent processes"}
          onClick={() => void (hasLeaks ? killLeaks(leaks.map((leak) => leak.pid)) : refresh())}
          disabled={killing}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 mr-1 text-xs font-mono transition-colors",
            hasLeaks
              ? "text-red-400 bg-red-500/10 hover:bg-red-500/20"
              : "text-muted-foreground hover:text-foreground hover:bg-elevation-2",
          )}
        />
      }>
        <Flame className={cn("size-3.5", killing && "animate-pulse")} />
        <span className="tabular-nums">{killing ? "…" : leaks.length}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="p-3">
        {hasLeaks ? (
          <div className="min-w-[220px] space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-wider">
              Leaked agent processes · {totalCpu.toFixed(0)}% CPU
            </div>
            {leaks.slice(0, 6).map((leak) => (
              <div key={leak.pid} className="flex items-center justify-between gap-3 text-[10px]">
                <span className="truncate text-muted-foreground">{leak.label} · {formatAge(leak.ageSeconds)}</span>
                <span className="shrink-0 font-semibold text-red-400">{leak.cpuPercent.toFixed(0)}%</span>
              </div>
            ))}
            {leaks.length > 6 && (
              <div className="text-[10px] text-muted-foreground">+{leaks.length - 6} more</div>
            )}
            <div className="border-t border-border/30 pt-1 text-[10px] text-muted-foreground">
              Click to kill {leaks.length === 1 ? "it" : "all of them"}
            </div>
          </div>
        ) : (
          <div className="min-w-[180px] space-y-1">
            <div className="text-[10px] font-medium uppercase tracking-wider">Leak monitor</div>
            <div className="text-[10px] text-muted-foreground">
              No leaked agent processes. Checks every minute — click to re-scan now.
            </div>
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
