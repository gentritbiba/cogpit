import { useTokenUsage, type UsageData } from "@/hooks/useTokenUsage"
import { agentShortName } from "@/lib/agents/presentation"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { DEFAULT_AGENT_KIND, type AgentKind } from "@/lib/agents"
import { formatTokenCount } from "@/lib/format"
import { formatMinorUnits } from "@/lib/localCommandReports"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"

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
  caution: "text-warning",
  warning: "text-warning",
  danger: "text-destructive",
}

function levelColor(pct: number | undefined): string {
  return USAGE_TEXT_COLOR[pct == null ? "nominal" : usageLevel(pct)]
}

type Credits = NonNullable<UsageData["extraUsage"]> & { usedCredits: number }

function isSpendingCredits(extra: UsageData["extraUsage"]): extra is Credits {
  return !!extra?.isEnabled && extra.usedCredits != null
}

/** Share of the monthly credit limit spent; undefined when there is no limit. */
function creditsPct({ usedCredits, monthlyLimit, utilization }: Credits): number | undefined {
  if (monthlyLimit == null) return undefined
  return utilization ?? (monthlyLimit > 0 ? usedCredits / monthlyLimit * 100 : 0)
}

/** Plan utilization, or credits spent for an account without plan windows. */
function headline(usage: UsageData): { text: string; pct?: number } | null {
  const planPct = usage.fiveHour?.utilization ?? usage.sevenDay?.utilization
  if (planPct != null) return { text: `${planPct.toFixed(0)}%`, pct: planPct }
  const credits = usage.extraUsage
  if (!isSpendingCredits(credits)) return null
  return { text: formatMinorUnits(credits.usedCredits, credits.currency), pct: creditsPct(credits) }
}

function CreditsSection({ credits }: { credits: Credits }) {
  const pct = creditsPct(credits)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Usage credits</span>
        <span className="font-semibold">{formatMinorUnits(credits.usedCredits, credits.currency)} spent</span>
      </div>
      {credits.monthlyLimit == null || pct == null ? (
        <div className="text-xs text-muted-foreground">No monthly limit</div>
      ) : (
        <>
          <Progress value={Math.min(pct, 100)} />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{formatMinorUnits(credits.monthlyLimit, credits.currency)} monthly limit</span>
            <span className={cn("font-semibold", levelColor(pct))}>{pct.toFixed(1)}% used</span>
          </div>
        </>
      )}
    </div>
  )
}

function TooltipBody({ usage }: { usage: UsageData }) {
  const rows: { label: string; pct: number; resetsAt?: string }[] = []

  if (usage.fiveHour) rows.push({ label: usage.fiveHour.label ?? "5-hour", pct: usage.fiveHour.utilization, resetsAt: usage.fiveHour.resetsAt })
  if (usage.sevenDay) rows.push({ label: usage.sevenDay.label ?? "7-day", pct: usage.sevenDay.utilization, resetsAt: usage.sevenDay.resetsAt })
  if (usage.sevenDayOpus) rows.push({ label: "Opus", pct: usage.sevenDayOpus.utilization, resetsAt: usage.sevenDayOpus.resetsAt })
  if (usage.sevenDaySonnet) rows.push({ label: "Sonnet", pct: usage.sevenDaySonnet.utilization, resetsAt: usage.sevenDaySonnet.resetsAt })

  return (
    <div className="flex min-w-[200px] flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide">{usage.agentKind ? agentShortName(usage.agentKind) : "Agent"} usage</span>
        {usage.subscriptionType && (
          <Badge variant="secondary">
            {usage.subscriptionType}
          </Badge>
        )}
      </div>
      {rows.map((r) => {
        const resetMs = r.resetsAt && usage.fetchedAt != null
          ? new Date(r.resetsAt).getTime() - usage.fetchedAt
          : null
        const resetH = resetMs != null ? Math.max(0, Math.round(resetMs / 3_600_000)) : null
        const level = usageLevel(r.pct)
        return (
          <div key={r.label} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{r.label}</span>
              <span className={cn("font-semibold", USAGE_TEXT_COLOR[level])}>
                {r.pct.toFixed(1)}%
              </span>
            </div>
            <Progress value={Math.min(r.pct, 100)} />
            {resetH != null && (
              <div className="text-xs text-muted-foreground">Resets in {resetH}h</div>
            )}
          </div>
        )
      })}
      {isSpendingCredits(usage.extraUsage) && (
        <>
          {rows.length > 0 && <Separator />}
          <CreditsSection credits={usage.extraUsage} />
        </>
      )}
      {(usage.lifetimeTokens != null || usage.creditBalance || usage.creditsUnlimited) && (
        <div className="flex flex-col gap-1 pt-1 text-xs text-muted-foreground">
          <Separator />
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
export function TokenUsageIndicator({ agentKind = DEFAULT_AGENT_KIND }: { agentKind?: AgentKind }) {
  const { usage, loading, available, refresh } = useTokenUsage(agentKind)

  if (!available || !usage) return null

  const primary = headline(usage)
  if (!primary) return null

  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="xs" aria-label={`Refresh ${usage.agentKind ? agentShortName(usage.agentKind) : "agent"} usage`} onClick={refresh} disabled={loading} className="mr-1 font-mono" />}>
          <span className={cn(
            "tabular-nums",
            levelColor(primary.pct),
            loading && "opacity-50",
          )}>
            {primary.text}
          </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="p-3">
        <TooltipBody usage={usage} />
      </TooltipContent>
    </Tooltip>
  )
}
