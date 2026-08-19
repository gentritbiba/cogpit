import { useTokenUsage, type UsageData } from "@/hooks/useTokenUsage"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import type { AgentKind } from "@/lib/sessionSource"
import { formatTokenCount } from "@/lib/format"

type UsageLevel = "nominal" | "caution" | "warning" | "danger"

/** Quota bands. Nominal reads neutral — only pressure earns a colour. */
function usageLevel(pct: number): UsageLevel {
  if (pct >= 90) return "danger"
  if (pct >= 80) return "warning"
  if (pct >= 60) return "caution"
  return "nominal"
}

const USAGE_TEXT_COLOR: Record<UsageLevel, string> = {
  nominal: "text-muted-foreground",
  caution: "text-yellow-400",
  warning: "text-orange-400",
  danger: "text-red-400",
}

const USAGE_BAR_COLOR: Record<UsageLevel, string> = {
  nominal: "bg-muted-foreground",
  caution: "bg-yellow-400",
  warning: "bg-orange-400",
  danger: "bg-red-400",
}

function TooltipBody({ usage }: { usage: UsageData }) {
  const rows: { label: string; pct: number; resetsAt?: string }[] = []

  if (usage.fiveHour) rows.push({ label: usage.fiveHour.label ?? "5-hour", pct: usage.fiveHour.utilization, resetsAt: usage.fiveHour.resetsAt })
  if (usage.sevenDay) rows.push({ label: usage.sevenDay.label ?? "7-day", pct: usage.sevenDay.utilization, resetsAt: usage.sevenDay.resetsAt })
  if (usage.sevenDayOpus) rows.push({ label: "Opus", pct: usage.sevenDayOpus.utilization, resetsAt: usage.sevenDayOpus.resetsAt })
  if (usage.sevenDaySonnet) rows.push({ label: "Sonnet", pct: usage.sevenDaySonnet.utilization, resetsAt: usage.sevenDaySonnet.resetsAt })

  return (
    <div className="space-y-2 min-w-[180px]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider">{usage.providerName ?? "Agent"} Usage</span>
        {usage.subscriptionType && (
          <span className="text-[9px] font-medium text-cyan-300 bg-cyan-500/15 border border-cyan-500/30 rounded px-1 py-0.5">
            {usage.subscriptionType}
          </span>
        )}
      </div>
      {rows.map((r) => {
        const resetMs = r.resetsAt && usage.fetchedAt != null
          ? new Date(r.resetsAt).getTime() - usage.fetchedAt
          : null
        const resetH = resetMs != null ? Math.max(0, Math.round(resetMs / 3_600_000)) : null
        const level = usageLevel(r.pct)
        return (
          <div key={r.label} className="space-y-0.5">
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground">{r.label}</span>
              <span className={cn("font-semibold", USAGE_TEXT_COLOR[level])}>
                {r.pct.toFixed(1)}%
              </span>
            </div>
            <div className="h-1 w-full rounded-full bg-elevation-3 overflow-hidden">
              <div
                className={cn("h-full rounded-full", USAGE_BAR_COLOR[level])}
                style={{ width: `${Math.min(r.pct, 100)}%`, opacity: 0.6 }}
              />
            </div>
            {resetH != null && (
              <div className="text-[9px] text-muted-foreground">resets in {resetH}h</div>
            )}
          </div>
        )
      })}
      {usage.extraUsage?.isEnabled && usage.extraUsage.usedCredits != null && usage.extraUsage.monthlyLimit != null && (
        <div className="pt-1 border-t border-border/30 text-[10px] text-muted-foreground">
          Extra: ${usage.extraUsage.usedCredits.toFixed(2)} / ${usage.extraUsage.monthlyLimit.toFixed(2)}
        </div>
      )}
      {(usage.lifetimeTokens != null || usage.creditBalance || usage.creditsUnlimited) && (
        <div className="space-y-1 border-t border-border/30 pt-1 text-[10px] text-muted-foreground">
          {usage.lifetimeTokens != null && <div>Lifetime: {formatTokenCount(usage.lifetimeTokens)} tokens</div>}
          {usage.creditsUnlimited
            ? <div>Credits: Unlimited</div>
            : usage.creditBalance ? <div>Credits: {usage.creditBalance}</div> : null}
        </div>
      )}
    </div>
  )
}

/**
 * Quota readout for the top bar — a single quiet number, because its slope is
 * what gets sampled. It only takes on colour under real quota pressure.
 * Renders nothing if usage is unavailable.
 */
export function TokenUsageIndicator({ agentKind = "claude" }: { agentKind?: AgentKind }) {
  const { usage, loading, available, refresh } = useTokenUsage(agentKind)

  if (!available || !usage) return null

  // Show the primary metric: 5-hour utilization
  const primary = usage.fiveHour?.utilization ?? usage.sevenDay?.utilization
  if (primary == null) return null

  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" aria-label={`Refresh ${usage.providerName ?? "agent"} usage`} onClick={refresh} disabled={loading} className="rounded-md px-1.5 py-1 text-xs font-mono hover:bg-elevation-2 transition-colors mr-1" />}>
          <span className={cn(
            "tabular-nums",
            USAGE_TEXT_COLOR[usageLevel(primary)],
            loading && "opacity-50",
          )}>
            {primary.toFixed(0)}%
          </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="p-3">
        <TooltipBody usage={usage} />
      </TooltipContent>
    </Tooltip>
  )
}
