import { CheckCircle2, Circle, Clock3, Loader2, Wrench, X, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatAgentLabel } from "@/components/timeline/agent-utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

export type AgentStatus = "running" | "done" | "failed" | "seen"

interface AgentCardProps {
  agentId: string
  subagentType: string | null
  agentName: string | null
  preview: string
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
  isViewing,
  isBackground,
  status,
  durationMs,
  toolUseCount,
  disabled,
  onClick,
  onStop,
}: AgentCardProps) {
  const label = agentName || formatAgentLabel(agentId, subagentType)
  const duration = durationMs == null
    ? null
    : durationMs < 1000
      ? `${durationMs}ms`
      : `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`
  const statusIcon = status === "running"
    ? <Loader2 className="size-3 shrink-0 animate-spin text-success" data-icon="inline-start" />
    : status === "done"
      ? <CheckCircle2 className="size-3 shrink-0 text-success" data-icon="inline-start" />
      : status === "failed"
        ? <XCircle className="size-3 shrink-0 text-destructive" data-icon="inline-start" />
        : <Circle className="size-2.5 shrink-0 text-muted-foreground" data-icon="inline-start" />

  return (
    <div
      className={cn(
        "motion-list-item flex w-full items-start border-b border-border text-left transition-colors last:border-b-0",
        isViewing
          ? "bg-accent"
          : "hover:bg-muted/40"
      )}
    >
      <Button type="button" variant="ghost" onClick={onClick} disabled={disabled} className="h-auto min-w-0 flex-1 flex-col items-stretch rounded-none px-2.5 py-2 text-left whitespace-normal">
        <div className="flex items-center gap-1.5">
          {statusIcon}
          <Badge variant="outline">
            {label}
          </Badge>
          {isBackground && <Badge variant="outline">Background</Badge>}
          {isViewing && <Badge>Viewing</Badge>}
          <span className="ml-auto text-xs uppercase tracking-wide text-muted-foreground">
            {status === "running" ? "active" : status}
          </span>
        </div>
        {preview && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{preview}</p>}
        {(duration || toolUseCount != null) && (
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            {duration && <span className="inline-flex items-center gap-0.5"><Clock3 className="size-2.5" data-icon="inline-start" />{duration}</span>}
            {toolUseCount != null && <span className="inline-flex items-center gap-0.5"><Wrench className="size-2.5" data-icon="inline-start" />{toolUseCount} tools</span>}
          </div>
        )}
      </Button>
      {onStop && (
        <Button type="button" variant="ghost" size="icon-sm" className="m-1" onClick={onStop} aria-label={`Stop ${label}`}>
          <X data-icon="inline-start" />
        </Button>
      )}
    </div>
  )
}
