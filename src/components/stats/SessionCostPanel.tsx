import { CircleDollarSign, Info, RefreshCw } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { useSessionUsageCost } from "@/hooks/useSessionUsageCost"
import { descriptorFor } from "@/lib/agents"
import { agentIcon } from "@/lib/agents/presentation"
import { formatTokenCount, shortenModel } from "@/lib/format"
import { formatCost } from "../../../shared/session/token-costs"
import { totalUsageCostTokens } from "../../../shared/contracts/usageCost"
import type {
  SessionUsageCostCall,
  SessionUsageCostSummary,
} from "../../../shared/contracts/usageCost"

interface SessionCostPanelProps {
  dirName: string | null
  fileName: string | null
  revision: string
}

interface CostRow {
  label: string
  tokens: number
  costUsd: number
}

function pricingLabel(summary: SessionUsageCostSummary): string {
  if (summary.records === 0) return "No usage"
  if (summary.unpricedRecords === summary.records) return "Rates unavailable"
  if (summary.unpricedRecords > 0) return "Partial estimate"
  if (summary.providerReportedRecords === summary.records) return "Provider reported"
  if (summary.providerReportedRecords > 0) return "Transcript + API rates"
  return "Current API rates"
}

function usageRows(summary: SessionUsageCostSummary): CostRow[] {
  return [
    {
      label: "New input",
      tokens: summary.totals.uncachedInputTokens,
      costUsd: summary.breakdown.uncachedInputUsd,
    },
    {
      label: "Cache reads",
      tokens: summary.totals.cachedInputTokens,
      costUsd: summary.breakdown.cachedInputUsd,
    },
    {
      label: "Cache writes",
      tokens: summary.totals.cacheCreationTokens,
      costUsd: summary.breakdown.cacheCreationUsd,
    },
    {
      label: "Output",
      tokens: summary.totals.outputTokens,
      costUsd: summary.breakdown.outputUsd,
    },
    {
      label: "Provider total",
      tokens: 0,
      costUsd: summary.breakdown.unallocatedUsd,
    },
  ].filter((row) => row.tokens > 0 || row.costUsd > 0)
}

function CostLoading(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-5 pt-2" role="status" aria-label="Reading session cost">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-3 w-44" />
      </div>
      <Skeleton className="h-20 w-full" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    </div>
  )
}

function CostUnavailable({ message, retry }: { message: string; retry: () => void }): React.JSX.Element {
  return (
    <Alert variant="destructive" className="mt-2">
      <Info />
      <AlertTitle>Cost unavailable</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
      <Button variant="outline" size="xs" onClick={retry} className="mt-2">
        <RefreshCw data-icon="inline-start" />
        Retry
      </Button>
    </Alert>
  )
}

function CostStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-medium text-foreground tabular-nums">{value}</dd>
    </div>
  )
}

function BreakdownRow({ row, totalCost }: { row: CostRow; totalCost: number }): React.JSX.Element {
  const share = totalCost > 0 ? (row.costUsd / totalCost) * 100 : 0
  return (
    <div className="flex flex-col gap-1.5">
      <Progress value={share}>
        <ProgressLabel>{row.label}</ProgressLabel>
        <ProgressValue>{() => formatCost(row.costUsd)}</ProgressValue>
      </Progress>
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground tabular-nums">
        <span>{row.tokens > 0 ? formatTokenCount(row.tokens) : "Reported by provider"}</span>
        <span>{share > 0 ? `${share.toFixed(1)}%` : "—"}</span>
      </div>
    </div>
  )
}

function ModelBreakdown({ summary }: { summary: SessionUsageCostSummary }): React.JSX.Element {
  return (
    <section aria-labelledby="cost-models-heading" className="flex flex-col gap-3">
      <h3 id="cost-models-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        By model
      </h3>
      <div className="flex flex-col gap-3">
        {summary.models.map((model) => {
          const share = summary.costUsd > 0 ? (model.costUsd / summary.costUsd) * 100 : 0
          return (
            <div key={model.model} className="flex flex-col gap-1.5">
              <Progress value={share}>
                <ProgressLabel title={model.model}>{shortenModel(model.model)}</ProgressLabel>
                <ProgressValue>
                  {() => model.costSource === "unpriced" ? "Unpriced" : formatCost(model.costUsd)}
                </ProgressValue>
              </Progress>
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground tabular-nums">
                <span>{model.records} {model.records === 1 ? "call" : "calls"}</span>
                <span>{formatTokenCount(totalUsageCostTokens(model.totals))} tokens</span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

type RankedCall = SessionUsageCostCall & { call: number }

function expensiveCalls(calls: readonly SessionUsageCostCall[]): RankedCall[] {
  return calls
    .map((call, index) => ({ ...call, call: index + 1 }))
    .filter((call) => call.costSource !== "unpriced")
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 5)
}

function ExpensiveCalls({ rows }: { rows: readonly RankedCall[] }): React.JSX.Element {
  return (
    <section aria-labelledby="cost-calls-heading" className="flex flex-col gap-2">
      <h3 id="cost-calls-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Most expensive calls
      </h3>
      <ol className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <li key={`${row.timestamp}:${row.call}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              Call {row.call} · {shortenModel(row.model)}
            </span>
            {row.isSubagent && <Badge variant="outline">Agent</Badge>}
            <span className="shrink-0 font-mono text-xs text-foreground tabular-nums">
              {formatCost(row.costUsd)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function SessionCost({ summary }: { summary: SessionUsageCostSummary }): React.JSX.Element {
  const ProviderIcon = agentIcon(summary.provider)
  const totalTokens = totalUsageCostTokens(summary.totals)
  const rows = usageRows(summary)
  const topCalls = expensiveCalls(summary.calls)
  const hasPricedRecords = summary.providerReportedRecords + summary.modelPricedRecords > 0

  return (
    <div className="flex flex-col gap-5 pt-2">
      <section aria-labelledby="session-cost-heading" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p id="session-cost-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            API equivalent
          </p>
          <Badge variant="outline">
            <ProviderIcon aria-hidden="true" />
            {descriptorFor(summary.provider).displayName}
          </Badge>
        </div>
        <div className="flex items-end justify-between gap-3">
          <span className="text-4xl font-semibold tracking-tight text-foreground tabular-nums">
            {hasPricedRecords ? formatCost(summary.costUsd) : "—"}
          </span>
          <Badge variant={summary.unpricedRecords > 0 ? "secondary" : "outline"}>
            {pricingLabel(summary)}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {summary.records} {summary.records === 1 ? "model call" : "model calls"}
          {summary.includedSubagents > 0
            ? ` · ${summary.includedSubagents} agent ${summary.includedSubagents === 1 ? "transcript" : "transcripts"}`
            : ""}
        </p>
      </section>

      <Separator />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <CostStat label="Processed tokens" value={formatTokenCount(totalTokens)} />
        <CostStat label="Cache savings" value={formatCost(summary.cacheSavingsUsd)} />
        <CostStat label="Cached input" value={formatTokenCount(summary.totals.cachedInputTokens)} />
        <CostStat label="Reasoning" value={formatTokenCount(summary.totals.reasoningTokens)} />
      </dl>

      {rows.length > 0 && (
        <>
          <Separator />
          <section aria-labelledby="cost-breakdown-heading" className="flex flex-col gap-3">
            <h3 id="cost-breakdown-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Cost by token type
            </h3>
            <div className="flex flex-col gap-4">
              {rows.map((row) => <BreakdownRow key={row.label} row={row} totalCost={summary.costUsd} />)}
            </div>
          </section>
        </>
      )}

      {summary.models.length > 0 && (
        <>
          <Separator />
          <ModelBreakdown summary={summary} />
        </>
      )}

      {topCalls.length >= 2 && (
        <>
          <Separator />
          <ExpensiveCalls rows={topCalls} />
        </>
      )}

      <Alert>
        <Info />
        <AlertTitle>How this is calculated</AlertTitle>
        <AlertDescription>
          Token counts come from the provider transcript. Costs use provider totals when present,
          then current LiteLLM API rates, the same pricing source as ccusage. This is not a
          subscription bill.
        </AlertDescription>
      </Alert>
    </div>
  )
}

export function SessionCostPanel({ dirName, fileName, revision }: SessionCostPanelProps): React.JSX.Element {
  const { summary, loading, error, refresh } = useSessionUsageCost(dirName, fileName, revision)

  if (error) return <CostUnavailable message={error} retry={refresh} />
  if (!summary) {
    if (loading) return <CostLoading />
    return (
      <Empty className="mt-2 min-h-52">
        <EmptyHeader>
          <EmptyMedia variant="icon"><CircleDollarSign /></EmptyMedia>
          <EmptyTitle>No transcript cost yet</EmptyTitle>
          <EmptyDescription>Cost appears after the first model response is written.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return <SessionCost summary={summary} />
}
