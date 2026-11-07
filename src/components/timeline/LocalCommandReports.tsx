import { type ReactNode } from "react"
import { useDisclosure, useDisclosureKey } from "./disclosure"
import { ChevronDown, Gauge, Lightbulb } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { CONTEXT_STYLES, contextPressure } from "@/components/header-shared"
import { formatCost, formatDuration, formatTokenCount, shortenModel } from "@/lib/format"
import {
  formatMinorUnits,
  formatResetTime,
  usageLimitLabel,
  usageSeverity,
  usageTextSections,
  type UsageSeverity,
  type UsageTextSection,
} from "@/lib/localCommandReports"
import { cn } from "@/lib/utils"
import type {
  ContextUsageCategory,
  LocalCommandContextUsage,
  LocalCommandUsageReport,
  UsageLimitRow,
} from "../../../shared/session/types"

function ReportFrame({ label, icon, aside, children }: { label: string; icon: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label} className="my-1 flex flex-col gap-3 rounded-lg border border-border bg-card p-3 text-xs">
      <header className="flex items-center gap-1.5">
        {icon}
        <h4 className="text-[13px] font-medium text-foreground">{label}</h4>
        {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
      </header>
      {children}
    </section>
  )
}

// ── /context ────────────────────────────────────────────────────────────────

const SEGMENT_COLORS = [
  "bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5",
  "bg-chart-1/45", "bg-chart-2/45", "bg-chart-3/45", "bg-chart-4/45", "bg-chart-5/45",
]
const BUFFER_COLOR = "bg-muted-foreground/35"

function categoryColor(category: ContextUsageCategory, usedIndex: number): string | null {
  if (category.kind === "used") return SEGMENT_COLORS[usedIndex % SEGMENT_COLORS.length]
  if (category.kind === "buffer") return BUFFER_COLOR
  return null
}

function formatShare(tokens: number, windowTokens: number): string {
  const share = (tokens / windowTokens) * 100
  if (share > 0 && share < 0.1) return "<0.1%"
  return `${share.toFixed(1)}%`
}

export function ContextUsageCard({ usage }: { usage: LocalCommandContextUsage }) {
  const windowTokens = usage.raw_max_tokens
  const pctLeft = Math.max(0, 100 - usage.percentage)
  const pressure = contextPressure(pctLeft)
  let usedIndex = 0
  const rows = usage.categories
    .filter((category) => category.tokens > 0)
    .map((category) => ({
      category,
      color: categoryColor(category, category.kind === "used" ? usedIndex++ : 0),
    }))
  const segments = rows.filter((row) => row.color)

  return (
    <ReportFrame
      label="Context"
      icon={<Gauge className="size-3.5 text-muted-foreground" aria-hidden />}
      aside={
        <>
          <span className="tabular-nums text-muted-foreground">
            {formatTokenCount(usage.total_tokens)} / {formatTokenCount(windowTokens)}
          </span>
          <Badge variant="outline" className={cn("tabular-nums", CONTEXT_STYLES[pressure])}>
            {pctLeft.toFixed(0)}% left
          </Badge>
        </>
      }
    >
      <div
        role="img"
        aria-label={`${usage.percentage}% of the context window in use`}
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        {segments.map(({ category, color }) => (
          <div
            key={category.name}
            className={cn("h-full", color)}
            style={{ width: `${Math.min(100, (category.tokens / windowTokens) * 100)}%` }}
          />
        ))}
      </div>
      {usage.over_limit && (
        <p className="text-destructive">
          {formatTokenCount(usage.over_limit.tokens_over)} tokens over the{" "}
          {usage.over_limit.kind === "hard_limit" ? "model's limit" : "compaction window"}
        </p>
      )}
      <ul className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 gap-y-1">
        {rows.map(({ category, color }) => (
          <li key={category.name} className={cn("contents", category.kind === "deferred" && "text-muted-foreground")}>
            <span
              aria-hidden
              className={cn("size-2 rounded-sm", color ?? "bg-muted ring-1 ring-inset ring-border")}
            />
            <span className="truncate">
              {category.name}
              {category.kind === "deferred" && <span className="text-muted-foreground"> · outside the window</span>}
            </span>
            <span className="text-right tabular-nums text-muted-foreground">{formatTokenCount(category.tokens)}</span>
            <span className="w-12 text-right tabular-nums text-muted-foreground">
              {category.kind === "deferred" ? "" : formatShare(category.tokens, windowTokens)}
            </span>
          </li>
        ))}
      </ul>
      <ContextDetails usage={usage} />
      <p className="text-muted-foreground">{shortenModel(usage.model)}</p>
    </ReportFrame>
  )
}

interface DetailItem {
  label: string
  meta?: string
  tokens: number
}

const DETAIL_LIMIT = 8

function ContextDetails({ usage }: { usage: LocalCommandContextUsage }) {
  const [open, setOpen] = useDisclosure(useDisclosureKey("breakdown"), false)
  const groups: { title: string; items: DetailItem[] }[] = [
    { title: "Memory files", items: (usage.memory_files ?? []).map((file) => ({ label: file.path, meta: file.type, tokens: file.tokens })) },
    { title: "MCP tools", items: (usage.mcp_tools ?? []).map((tool) => ({ label: tool.name, meta: tool.server_name, tokens: tool.tokens })) },
    { title: "Custom agents", items: (usage.agents ?? []).map((agent) => ({ label: agent.agent_type, tokens: agent.tokens })) },
    { title: "Skills", items: (usage.skills ?? []).map((skill) => ({ label: skill.name, meta: skill.plugin_name, tokens: skill.tokens })) },
  ].filter((group) => group.items.length > 0)
  if (groups.length === 0) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border/60 pt-2">
      <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
        <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} aria-hidden />
        Breakdown
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 pt-2">
        {groups.map((group) => {
          const items = [...group.items].sort((a, b) => b.tokens - a.tokens)
          const total = items.reduce((sum, item) => sum + item.tokens, 0)
          return (
            <div key={group.title} className="flex flex-col gap-1">
              <div className="flex justify-between font-medium text-foreground">
                <span>{group.title} · {items.length}</span>
                <span className="tabular-nums text-muted-foreground">{formatTokenCount(total)}</span>
              </div>
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                {items.slice(0, DETAIL_LIMIT).map((item, index) => (
                  <li key={`${item.label}-${index}`} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate font-mono" title={item.label}>
                      {item.label}
                      {item.meta && <span className="font-sans"> · {item.meta}</span>}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatTokenCount(item.tokens)}</span>
                  </li>
                ))}
                {items.length > DETAIL_LIMIT && <li>+{items.length - DETAIL_LIMIT} more</li>}
              </ul>
            </div>
          )
        })}
      </CollapsibleContent>
    </Collapsible>
  )
}

// ── /usage ──────────────────────────────────────────────────────────────────

const SEVERITY_TEXT: Record<UsageSeverity, string> = {
  normal: "text-muted-foreground",
  warning: "text-warning",
  critical: "text-destructive",
}

const SEVERITY_BAR: Record<UsageSeverity, string> = {
  normal: "bg-foreground/70",
  warning: "bg-warning",
  critical: "bg-destructive",
}

function UsageMeter({ row }: { row: UsageLimitRow }) {
  const severity = usageSeverity(row.severity)
  const label = usageLimitLabel(row)
  const resets = formatResetTime(row.resets_at)
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn("text-foreground", row.is_active && "font-medium")}>{label}</span>
        <span className={cn("font-semibold tabular-nums", SEVERITY_TEXT[severity])}>{row.percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={row.percent}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full rounded-full", SEVERITY_BAR[severity])} style={{ width: `${Math.min(100, Math.max(0, row.percent))}%` }} />
      </div>
      {resets && <span className="text-muted-foreground">Resets {resets}</span>}
    </li>
  )
}

/** Slash commands in a hint read as code, so the reader sees what to type. */
function HintText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\/[\w:-]+)/).map((part, index) =>
        index % 2 === 1
          ? <code key={index} className="rounded bg-muted px-1 font-mono text-foreground">{part}</code>
          : part,
      )}
    </>
  )
}

function UsageTextBlock({ section }: { section: UsageTextSection }) {
  if (section.kind === "note") {
    return (
      <div className="text-muted-foreground">
        {section.lines.map((line, index) => <p key={index}>{line}</p>)}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1.5">
      <h5 className="font-medium text-foreground">{section.heading}</h5>
      {section.recommendations.length > 0 && (
        <ul className="flex flex-col gap-1">
          {section.recommendations.map((recommendation, index) => (
            <li key={index} className="grid grid-cols-[2.5rem_1fr] items-baseline gap-2">
              <span className="text-right tabular-nums text-muted-foreground">{recommendation.pct}%</span>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                <Lightbulb className="size-3 shrink-0 self-center text-muted-foreground" aria-hidden />
                <span className="text-foreground">{recommendation.title}</span>
                {recommendation.detail && (
                  <span className="text-muted-foreground"><HintText text={recommendation.detail} /></span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {section.notes.map((note, index) => (
        <p key={index} className="text-muted-foreground">{note}</p>
      ))}
    </div>
  )
}

function SessionTotals({ session }: { session: LocalCommandUsageReport["session"] }) {
  const parts: string[] = []
  if (session.total_cost_usd > 0) parts.push(formatCost(session.total_cost_usd))
  if (session.total_api_duration_ms > 0) parts.push(`${formatDuration(session.total_api_duration_ms)} API`)
  if (session.total_lines_added > 0 || session.total_lines_removed > 0) {
    parts.push(`+${session.total_lines_added} −${session.total_lines_removed} lines`)
  }
  if (parts.length === 0) return null
  return <p className="text-muted-foreground">This session: {parts.join(" · ")}</p>
}

export function UsageReportCard({ report, limits, text }: { report: LocalCommandUsageReport; limits: UsageLimitRow[]; text: string }) {
  const extra = report.rate_limits?.extra_usage
  const { lead, details } = usageTextSections(text)
  return (
    <ReportFrame label="Plan usage" icon={<Gauge className="size-3.5 text-muted-foreground" aria-hidden />}>
      {lead.map((section, index) => <UsageTextBlock key={index} section={section} />)}
      <ul className="flex flex-col gap-2.5">
        {limits.map((row, index) => <UsageMeter key={`${row.kind}-${index}`} row={row} />)}
      </ul>
      {extra?.is_enabled && extra.used_credits != null && (
        <p className="text-muted-foreground">
          Extra usage: {formatMinorUnits(extra.used_credits, extra.currency)}
          {extra.monthly_limit != null && <> / {formatMinorUnits(extra.monthly_limit, extra.currency)}</>}
        </p>
      )}
      {report.session && <SessionTotals session={report.session} />}
      {details.length > 0 && (
        <div className="flex flex-col gap-3 border-t border-border/60 pt-3">
          {details.map((section, index) => <UsageTextBlock key={index} section={section} />)}
        </div>
      )}
    </ReportFrame>
  )
}
