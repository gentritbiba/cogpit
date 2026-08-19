import { CheckCircle2, Circle, Clock3, Loader2, Wrench, X, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatAgentLabel } from "@/components/timeline/agent-utils"
import { Button } from "@/components/ui/button"

export type AgentStatus = "running" | "done" | "failed" | "seen"

const AGENT_BADGE_COLORS = [
  "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  "bg-amber-500/15 text-amber-300 border-amber-500/30",
  "bg-rose-500/15 text-rose-300 border-rose-500/30",
  "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
]

interface AgentCardProps {
  agentId: string
  subagentType: string | null
  agentName: string | null
  preview: string
  colorIndex: number
  isViewing: boolean
  isBackground?: boolean
  status: AgentStatus
  durationMs?: number
  toolUseCount?: number
  disabled?: boolean
  onClick: () => void
  onStop?: () => void
}

export function AgentCard({
  agentId,
  subagentType,
  agentName,
  preview,
  colorIndex,
  isViewing,
  isBackground,
  status,
  durationMs,
  toolUseCount,
  disabled,
  onClick,
  onStop,
}: AgentCardProps) {
  const badgeColor = AGENT_BADGE_COLORS[colorIndex % AGENT_BADGE_COLORS.length]
  const label = agentName || formatAgentLabel(agentId, subagentType)
  const duration = durationMs == null
    ? null
    : durationMs < 1000
      ? `${durationMs}ms`
      : `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`
  const statusIcon = status === "running"
    ? <Loader2 className="size-3 shrink-0 animate-spin text-emerald-400" />
    : status === "done"
      ? <CheckCircle2 className="size-3 shrink-0 text-emerald-400" />
      : status === "failed"
        ? <XCircle className="size-3 shrink-0 text-red-400" />
        : <Circle className="size-2.5 shrink-0 text-muted-foreground" />

  return (
    <div
      className={cn(
        "flex w-full items-start rounded border elevation-2 depth-low text-left transition-colors",
        isViewing
          ? "border-blue-500/50 bg-blue-500/10 ring-1 ring-blue-500/30"
          : "border-border hover:bg-elevation-3"
      )}
    >
      <button type="button" onClick={onClick} disabled={disabled} className="min-w-0 flex-1 px-2.5 py-2 text-left disabled:cursor-default">
        <div className="flex items-center gap-1.5">
          {statusIcon}
          <span
            className={cn(
              "inline-flex items-center rounded border px-1.5 py-0 text-[10px]",
              badgeColor
            )}
          >
            {label}
          </span>
          {isBackground && <span className="text-[9px] font-medium uppercase text-violet-400/70">bg</span>}
          {isViewing && <span className="text-[9px] font-medium text-blue-400">viewing</span>}
          <span className="ml-auto text-[9px] uppercase tracking-wide text-muted-foreground">
            {status === "running" ? "active" : status}
          </span>
        </div>
        {preview && <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-muted-foreground">{preview}</p>}
        {(duration || toolUseCount != null) && (
          <div className="mt-1.5 flex items-center gap-2 text-[9px] text-muted-foreground/70">
            {duration && <span className="inline-flex items-center gap-0.5"><Clock3 className="size-2.5" />{duration}</span>}
            {toolUseCount != null && <span className="inline-flex items-center gap-0.5"><Wrench className="size-2.5" />{toolUseCount} tools</span>}
          </div>
        )}
      </button>
      {onStop && (
        <Button type="button" variant="ghost" size="icon-sm" className="m-1" onClick={onStop} aria-label={`Stop ${label}`}>
          <X />
        </Button>
      )}
    </div>
  )
}
