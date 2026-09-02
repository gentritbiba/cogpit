import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/Spinner"
import { useUsageCost } from "@/hooks/useUsageCost"
import { cn } from "@/lib/utils"
import { formatCost } from "../../shared/session/token-costs"
import { formatTokenCount } from "@/lib/format"
import {
  totalUsageCostTokens,
  type UsageCostProvider,
  type UsageCostSummary,
} from "@/lib/usagePricing"
import { descriptorFor } from "@/lib/agents"
import { AGENT_DISPLAY_ORDER, agentChartColor } from "@/lib/agents/presentation"

const WINDOW_OPTIONS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const

type Metric = "cost" | "tokens"

/**
 * Fixed agent order and colors — identity-stable, never reassigned. Names and
 * colours come from the registry, so a legend cannot spell an agent differently
 * from the rest of the app or miss one entirely.
 */
const PROVIDERS: { key: UsageCostProvider; label: string; color: string }[] =
  AGENT_DISPLAY_ORDER.map((kind) => ({
    key: kind,
    label: descriptorFor(kind).displayName,
    color: agentChartColor(kind),
  }))

interface DayTotals {
  day: string
  byProvider: Record<UsageCostProvider, { costUsd: number; tokens: number }>
  costUsd: number
  tokens: number
}

interface ModelRow {
  provider: UsageCostProvider
  model: string
  costUsd: number
  tokens: number
  unpriced: boolean
}

interface Derived {
  costUsd: number
  tokens: number
  cacheSavingsUsd: number
  byProvider: Record<UsageCostProvider, { costUsd: number; tokens: number }>
  days: DayTotals[]
  models: ModelRow[]
}

function enumerateDays(sinceDay: string, untilDay: string): string[] {
  const days: string[] = []
  const DAY_MS = 24 * 60 * 60 * 1000
  const end = Date.parse(`${untilDay}T00:00:00Z`)
  for (let t = Date.parse(`${sinceDay}T00:00:00Z`); t <= end; t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10))
  }
  return days
}

function emptyProviderTotals(): Record<UsageCostProvider, { costUsd: number; tokens: number }> {
  return {
    claude: { costUsd: 0, tokens: 0 },
    codex: { costUsd: 0, tokens: 0 },
    copilot: { costUsd: 0, tokens: 0 },
  }
}

function derive(summary: UsageCostSummary): Derived {
  const byDay = new Map<string, DayTotals>()
  for (const day of enumerateDays(summary.sinceDay, summary.untilDay)) {
    byDay.set(day, { day, byProvider: emptyProviderTotals(), costUsd: 0, tokens: 0 })
  }

  const byModel = new Map<string, ModelRow>()
  const totals: Derived = {
    costUsd: 0,
    tokens: 0,
    cacheSavingsUsd: 0,
    byProvider: emptyProviderTotals(),
    days: [],
    models: [],
  }

  for (const bucket of summary.buckets) {
    const tokens = totalUsageCostTokens(bucket.totals)
    totals.costUsd += bucket.costUsd
    totals.tokens += tokens
    totals.cacheSavingsUsd += bucket.cacheSavingsUsd
    totals.byProvider[bucket.provider].costUsd += bucket.costUsd
    totals.byProvider[bucket.provider].tokens += tokens

    const day = byDay.get(bucket.day)
    if (day) {
      day.byProvider[bucket.provider].costUsd += bucket.costUsd
      day.byProvider[bucket.provider].tokens += tokens
      day.costUsd += bucket.costUsd
      day.tokens += tokens
    }

    const modelKey = `${bucket.provider}:${bucket.model}`
    let row = byModel.get(modelKey)
    if (!row) {
      row = { provider: bucket.provider, model: bucket.model, costUsd: 0, tokens: 0, unpriced: true }
      byModel.set(modelKey, row)
    }
    row.costUsd += bucket.costUsd
    row.tokens += tokens
    if (bucket.costSource !== "unpriced") row.unpriced = false
  }

  totals.days = [...byDay.values()]
  totals.models = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
  return totals
}

function formatDayShort(day: string): string {
  const parsed = Date.parse(`${day}T00:00:00Z`)
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed)
}

// ── Daily stacked bar chart ─────────────────────────────────────────────────

const CHART_W = 720
const CHART_H = 180
const PAD_BOTTOM = 18

function DailyChart({ days, metric }: { days: DayTotals[]; metric: Metric }) {
  const [hovered, setHovered] = useState<number | null>(null)

  const value = (entry: { costUsd: number; tokens: number }) =>
    metric === "cost" ? entry.costUsd : entry.tokens
  const maxVal = Math.max(...days.map((d) => value(d)))
  if (maxVal <= 0) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
        No activity in this window.
      </div>
    )
  }

  const plotH = CHART_H - PAD_BOTTOM
  const step = CHART_W / days.length
  const barW = Math.max(2, Math.min(28, step - 2))
  const hoveredDay = hovered !== null ? days[hovered] : null

  return (
    <div className="relative">
      {hoveredDay && (
        <div className="pointer-events-none absolute left-0 right-0 top-0 z-10 flex justify-center">
          <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-xs">
            <span className="font-medium">{formatDayShort(hoveredDay.day)}</span>
            {PROVIDERS.map(({ key, label, color }) => {
              const entry = hoveredDay.byProvider[key]
              if (value(entry) <= 0) return null
              return (
                <span key={key} className="ml-2 inline-flex items-center gap-1 text-muted-foreground">
                  <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
                  {label}: {metric === "cost" ? formatCost(entry.costUsd) : formatTokenCount(entry.tokens)}
                </span>
              )
            })}
            <span className="ml-2 font-medium">
              {metric === "cost" ? formatCost(hoveredDay.costUsd) : formatTokenCount(hoveredDay.tokens)}
            </span>
          </div>
        </div>
      )}
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="w-full"
        role="img"
        aria-label={`Daily ${metric === "cost" ? "raw API cost" : "processed tokens"} by provider`}
        onMouseLeave={() => setHovered(null)}
      >
        <line x1={0} y1={plotH} x2={CHART_W} y2={plotH} stroke="var(--border)" strokeWidth={1} />
        {days.map((d, i) => {
          const x = i * step + (step - barW) / 2
          let y = plotH
          const isHovered = hovered === i
          return (
            <g key={d.day} onMouseEnter={() => setHovered(i)}>
              {/* Full-height hit target: bars can be slivers. */}
              <rect x={i * step} y={0} width={step} height={plotH} fill="transparent" />
              {isHovered && (
                <rect x={i * step} y={0} width={step} height={plotH} fill="var(--foreground)" opacity={0.05} rx={2} />
              )}
              {PROVIDERS.map(({ key, color }) => {
                const v = value(d.byProvider[key])
                if (v <= 0) return null
                const h = (v / maxVal) * (plotH - 6)
                y -= h
                return (
                  <rect
                    key={key}
                    x={x}
                    y={y}
                    width={barW}
                    height={Math.max(1, h - 1.5)}
                    rx={1.5}
                    fill={color}
                    opacity={isHovered ? 1 : 0.85}
                  />
                )
              })}
            </g>
          )
        })}
        {days.map((d, i) =>
          // Sparse x labels: first, last, and roughly every seventh in between.
          i === 0 || i === days.length - 1 || (days.length > 10 && i % 7 === 0 && i < days.length - 3) ? (
            <text
              key={d.day}
              x={i * step + step / 2}
              y={CHART_H - 4}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {formatDayShort(d.day)}
            </text>
          ) : null,
        )}
      </svg>
      <div className="mt-1 flex items-center gap-4">
        {PROVIDERS.map(({ key, label, color }) => (
          <span key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: color }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Dialog ──────────────────────────────────────────────────────────────────

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground tabular-nums">{value}</span>
    </div>
  )
}

function UsageCostBody({ days }: { days: number }) {
  const { summary, loading, error, refresh } = useUsageCost(days, true)
  const [metric, setMetric] = useState<Metric>("cost")
  const derived = useMemo(() => (summary ? derive(summary) : null), [summary])

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
        {error}
        <Button variant="outline" size="sm" onClick={refresh}>Retry</Button>
      </div>
    )
  }
  if (!derived || !summary) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Scanning transcripts…
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-5", loading && "opacity-60")}>
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-3xl font-semibold text-foreground tabular-nums">
            {metric === "cost" ? formatCost(derived.costUsd) : formatTokenCount(derived.tokens)}
          </span>
          <span className="text-xs text-muted-foreground">
            {summary.distinctSessions} sessions · {metric === "cost" ? "raw API price" : "processed tokens"}
          </span>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex rounded-md border p-0.5">
            {(["cost", "tokens"] as const).map((option) => (
              <Button
                key={option}
                variant={metric === option ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setMetric(option)}
              >
                {option === "cost" ? "Cost" : "Tokens"}
              </Button>
            ))}
          </div>
          {PROVIDERS.map(({ key, label }) => {
            const entry = derived.byProvider[key]
            if (entry.costUsd === 0 && entry.tokens === 0) return null
            return (
              <span key={key} className="text-xs text-muted-foreground tabular-nums">
                {label}: {metric === "cost" ? formatCost(entry.costUsd) : formatTokenCount(entry.tokens)}
              </span>
            )
          })}
        </div>
      </div>

      <DailyChart days={derived.days} metric={metric} />

      <div className="grid grid-cols-3 gap-x-6 gap-y-3 border-t pt-3">
        <StatTile label="Processed tokens" value={formatTokenCount(derived.tokens)} />
        <StatTile label="Cache savings" value={formatCost(derived.cacheSavingsUsd)} />
        <StatTile label="Files scanned" value={String(summary.scannedFiles)} />
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1.5 font-normal">Model</th>
            <th className="py-1.5 text-right font-normal">Cost</th>
            <th className="py-1.5 text-right font-normal">Share</th>
            <th className="py-1.5 text-right font-normal">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {derived.models.map((row) => (
            <tr key={`${row.provider}:${row.model}`} className="border-b border-border/50">
              <td className="max-w-56 truncate py-1.5 text-foreground">
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: PROVIDERS.find((p) => p.key === row.provider)?.color }}
                  />
                  {row.model}
                </span>
              </td>
              <td className="py-1.5 text-right text-foreground tabular-nums">
                {row.unpriced ? "—" : formatCost(row.costUsd)}
              </td>
              <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                {derived.costUsd > 0 && !row.unpriced
                  ? `${((row.costUsd / derived.costUsd) * 100).toFixed(1)}%`
                  : "—"}
              </td>
              <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                {formatTokenCount(row.tokens)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs text-muted-foreground">
        Raw API-equivalent prices from LiteLLM rates
        {summary.pricing.status === "unavailable" ? " (rate table unavailable — costs incomplete)" : ""}
        {" "}— not what a subscription bills.
      </p>
    </div>
  )
}

interface UsageCostDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Raw API-equivalent spend across all sessions. Opened from the overflow menu. */
export function UsageCostDialog({ open, onOpenChange }: UsageCostDialogProps) {
  const [days, setDays] = useState<number>(30)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-4 pr-6">
            <div>
              <DialogTitle>API usage</DialogTitle>
              <DialogDescription>
                What this machine's agent usage would cost at raw API prices.
              </DialogDescription>
            </div>
            <div className="flex rounded-md border p-0.5">
              {WINDOW_OPTIONS.map((option) => (
                <Button
                  key={option.days}
                  variant={days === option.days ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => setDays(option.days)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        </DialogHeader>
        {open && <UsageCostBody days={days} />}
      </DialogContent>
    </Dialog>
  )
}
