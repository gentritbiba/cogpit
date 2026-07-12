import { useState } from "react"
import { ChevronRight, Wrench, Coins, Clock, Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"
import {
  agentStateStyle,
  formatTokens,
  isTerminalAgentState,
  type WorkflowAgent,
} from "@/lib/workflow-types"

/** One agent within a workflow phase: state, live tool, metrics, expandable previews. */
export function WorkflowAgentCard({ agent }: { agent: WorkflowAgent }) {
  const [showPrompt, setShowPrompt] = useState(false)
  const [showResult, setShowResult] = useState(false)
  const style = agentStateStyle(agent.state)
  const running = !isTerminalAgentState(agent.state) && agent.state !== "queued"

  return (
    <div className="rounded-md border border-border bg-elevation-1 px-2.5 py-2">
      {/* Header line: state dot, label, badge */}
      <div className="flex items-center gap-2">
        <span className="relative flex size-2 shrink-0">
          {running && (
            <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-75", style.dot)} />
          )}
          <span className={cn("relative inline-flex size-2 rounded-full", style.dot)} />
        </span>
        <span className="flex-1 min-w-0 truncate text-xs font-medium text-foreground" title={agent.label}>
          {agent.label}
        </span>
        <Badge variant="outline" className={cn("h-4 px-1.5 text-[9px] font-semibold uppercase tracking-wide", style.badge)}>
          {style.label}
        </Badge>
      </div>

      {/* Metrics */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {agent.model && (
          <span className="truncate max-w-[140px]" title={agent.model}>{agent.model.replace(/\[1m\]$/, "")}</span>
        )}
        {typeof agent.tokens === "number" && agent.tokens > 0 && (
          <span className="inline-flex items-center gap-1"><Coins className="size-2.5" />{formatTokens(agent.tokens)}</span>
        )}
        {typeof agent.toolCalls === "number" && agent.toolCalls > 0 && (
          <span className="inline-flex items-center gap-1"><Wrench className="size-2.5" />{agent.toolCalls}</span>
        )}
        {typeof agent.durationMs === "number" && (
          <span className="inline-flex items-center gap-1"><Clock className="size-2.5" />{formatDuration(agent.durationMs)}</span>
        )}
        {agent.attempt && agent.attempt > 1 && (
          <span className="text-amber-400/80">attempt {agent.attempt}</span>
        )}
      </div>

      {/* Live tool activity (running only) */}
      {running && agent.lastToolName && (
        <div className="mt-1.5 flex items-start gap-1.5 rounded bg-blue-500/5 px-1.5 py-1 text-[10px] text-blue-300/90">
          <Loader2 className="mt-0.5 size-2.5 shrink-0 animate-spin" />
          <span className="min-w-0">
            <span className="font-medium">{agent.lastToolName}</span>
            {agent.lastToolSummary && <span className="text-muted-foreground"> — {agent.lastToolSummary}</span>}
          </span>
        </div>
      )}

      {/* Expandable prompt / result previews */}
      {(agent.promptPreview || agent.resultPreview) && (
        <div className="mt-1.5 flex flex-col gap-1">
          {agent.promptPreview && (
            <DisclosureLine open={showPrompt} onToggle={() => setShowPrompt((v) => !v)} label="Prompt">
              {agent.promptPreview}
            </DisclosureLine>
          )}
          {agent.resultPreview && (
            <DisclosureLine open={showResult} onToggle={() => setShowResult((v) => !v)} label="Result">
              {agent.resultPreview}
            </DisclosureLine>
          )}
        </div>
      )}
    </div>
  )
}

function DisclosureLine({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean
  onToggle: () => void
  label: string
  children: string
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-elevation-0 p-2 text-[10px] leading-relaxed text-muted-foreground">
          {children}
        </pre>
      )}
    </div>
  )
}
