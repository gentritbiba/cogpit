/**
 * One session, rendered as a Mission Control card.
 *
 * Density is the point: state, current work, diffstat, metrics and context
 * pressure at a glance, so a wall of these is scannable without opening any.
 */

import { memo } from "react"
import { CheckCircle2, ChevronRight, MessageCircleQuestion, XCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatRelativeTime, formatTokenCount } from "@/lib/format"
import { getToolBadgeStyle } from "@/components/timeline/ToolCallCard"
import { LineCounts } from "@/components/shared/ChangeCounts"
import { sessionTitle } from "@/components/LiveSessions/sessionListView"
import { shortenModel } from "@/lib/format"
import type { PermissionDecision } from "@/lib/permissionApi"
import { PermissionPrompt } from "./PermissionPrompt"
import {
  contextBarColor,
  formatElapsed,
  formatTokens,
  type MissionCard,
  type MissionCardState,
} from "./missionControlView"

interface StateStyle {
  label: string
  text: string
  border: string
  surface: string
}

const STATE_STYLES: Record<MissionCardState, StateStyle> = {
  awaiting_approval: {
    label: "Waiting for approval",
    text: "text-amber-400",
    border: "border-amber-500/60",
    surface: "bg-amber-500/[0.045]",
  },
  awaiting_answer: {
    label: "Waiting for your answer",
    text: "text-amber-400",
    border: "border-amber-500/40",
    surface: "bg-amber-500/[0.03]",
  },
  running: {
    label: "Running",
    text: "text-blue-400",
    border: "border-border/70",
    surface: "",
  },
  done: {
    label: "Done",
    text: "text-green-400",
    border: "border-green-500/25",
    surface: "",
  },
  failed: {
    label: "Failed",
    text: "text-red-400",
    border: "border-red-500/35",
    surface: "",
  },
}

function StateIcon({ state }: { state: MissionCardState }) {
  switch (state) {
    case "running":
      // animate-pulse/ping are globally disabled for GPU reasons; live-pulse is
      // the sanctioned pulsing indicator.
      return <span className="live-pulse size-[7px] shrink-0 rounded-full bg-blue-400" />
    case "awaiting_approval":
    case "awaiting_answer":
      return <MessageCircleQuestion className="size-3.5 shrink-0" />
    case "done":
      return <CheckCircle2 className="size-3.5 shrink-0" />
    case "failed":
      return <XCircle className="size-3.5 shrink-0" />
  }
}

interface SessionCardProps {
  card: MissionCard
  customName?: string
  projectLabel: string
  responding: Set<string>
  compact?: boolean
  onOpen: () => void
  onRespond: (sessionId: string, requestId: string, behavior: PermissionDecision) => void
}

export const SessionCard = memo(function SessionCard({
  card,
  customName,
  projectLabel,
  responding,
  compact = false,
  onOpen,
  onRespond,
}: SessionCardProps) {
  const { session, state, summary, permissions } = card
  const style = STATE_STYLES[state]
  const request = permissions[0]
  const context = summary?.context ?? null
  const files = summary?.files ?? []
  const filesTotal = summary?.filesTotal
  const turns = session.turnCount ?? summary?.turnCount ?? 0

  return (
    <div
      className={cn(
        "group flex min-w-0 flex-col gap-2 rounded-lg border bg-elevation-2 p-3 text-left transition-colors",
        style.border,
        style.surface,
        state === "awaiting_approval" && "ring-1 ring-amber-500/20",
        compact && "gap-1.5 py-2",
      )}
    >
      {/* Header: project · model, and the click target for opening the session */}
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-col gap-1 text-left"
        aria-label={`Open session ${sessionTitle(session, customName)}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
            {projectLabel}
          </span>
          {summary?.model && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
              {shortenModel(summary.model)}
            </span>
          )}
          <ChevronRight className="size-3 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60" />
        </span>
        <span className="truncate text-[13.5px] font-semibold leading-tight tracking-tight text-foreground/95">
          {sessionTitle(session, customName)}
        </span>
      </button>

      {/* State line */}
      <div className={cn("flex items-center gap-1.5 text-[11.5px] font-semibold", style.text)}>
        <StateIcon state={state} />
        <span className="truncate">{style.label}</span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] font-normal text-muted-foreground/70">
          {formatRelativeTime(session.lastActivityAt || session.lastModified)}
        </span>
      </div>

      {/* Blocked on the user — answerable right here */}
      {request && (
        <PermissionPrompt
          request={request}
          queued={permissions.length - 1}
          responding={responding.has(request.requestId)}
          onRespond={(requestId, behavior) => onRespond(session.sessionId, requestId, behavior)}
        />
      )}

      {/* What it is doing right now */}
      {!request && summary?.currentTool && (
        <div className="rounded-md border border-border/40 bg-black/25 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <Badge
              variant="outline"
              className={cn(
                "h-4 shrink-0 px-1.5 py-0 font-mono text-[10px]",
                getToolBadgeStyle(summary.currentTool.name),
              )}
            >
              {summary.currentTool.name}
            </Badge>
            <code className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-foreground/75">
              {summary.currentTool.summary}
            </code>
          </div>
        </div>
      )}

      {/* Latest prose */}
      {!compact && !request && summary?.lastAssistantText && (
        <p className="line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {summary.lastAssistantText}
        </p>
      )}

      {/* Files changed */}
      {!compact && files.length > 0 && filesTotal && (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground/70">
            <span>
              {filesTotal.count} file{filesTotal.count === 1 ? "" : "s"} changed
            </span>
            <LineCounts add={filesTotal.additions} del={filesTotal.deletions} />
          </div>
          {files.map((file) => (
            <div key={file.path} className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground/85">
                {file.path.split("/").slice(-2).join("/")}
              </span>
              <LineCounts add={file.additions} del={file.deletions} />
            </div>
          ))}
        </div>
      )}

      {/* Tool trail */}
      {!compact && summary && summary.toolTrail.length > 0 && (
        <div className="flex items-center gap-1">
          {summary.toolTrail.map((tool, i) => (
            <span key={`${tool}-${i}`} className="flex items-center gap-1">
              {i > 0 && <span className="text-[10px] text-muted-foreground/30">›</span>}
              <Badge
                variant="outline"
                className={cn("h-4 px-1.5 py-0 font-mono text-[9.5px]", getToolBadgeStyle(tool))}
              >
                {tool}
              </Badge>
            </span>
          ))}
          {summary.totalToolCalls > summary.toolTrail.length && (
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/50">
              +{summary.totalToolCalls - summary.toolTrail.length} calls
            </span>
          )}
        </div>
      )}

      {/* Metrics */}
      <div
        className={cn(
          "mt-auto flex items-stretch border-t border-border/40 pt-2",
          // Full-width list rows would otherwise fling the three metrics to
          // opposite ends of the screen.
          compact && "max-w-xs gap-6",
        )}
      >
        <Metric label="Elapsed" value={summary ? formatElapsed(summary.elapsedMs) : "—"} />
        <Metric label="Turns" value={String(turns)} />
        <Metric label="Tokens" value={summary ? formatTokens(summary.tokens.total) : "—"} />
      </div>

      {/* Context pressure */}
      {context && context.used > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between font-mono text-[9.5px] text-muted-foreground/70">
            <span>
              context {formatTokenCount(context.used)} / {formatTokenCount(context.limit)}
            </span>
            <span>{context.percent}%</span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-elevation-0">
            <div
              className={cn("h-full rounded-full transition-all", contextBarColor(context.percent))}
              style={{ width: `${Math.max(1, Math.min(100, context.percent))}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
})

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1">
      <span className="block text-[9px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      <span className="mt-0.5 block truncate font-mono text-[12.5px] font-semibold tracking-tight text-foreground/90">
        {value}
      </span>
    </div>
  )
}
