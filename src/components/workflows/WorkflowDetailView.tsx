import { useState } from "react"
import {
  Workflow as WorkflowIcon,
  Bot,
  Coins,
  Wrench,
  Clock,
  Layers,
  Octagon,
  Code2,
  ChevronRight,
  Loader2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatDuration } from "@/lib/format"
import {
  agentProgress,
  formatTokens,
  groupAgentsByPhase,
  isWorkflowActive,
  workflowStatusStyle,
  type WorkflowDetail,
} from "@/lib/workflow-types"
import { WorkflowAgentCard } from "./WorkflowAgentCard"

interface WorkflowDetailViewProps {
  detail: WorkflowDetail
  stopping: boolean
  confirming: boolean
  onForceStop: () => void
}

export function WorkflowDetailView({ detail, stopping, confirming, onForceStop }: WorkflowDetailViewProps) {
  const [showScript, setShowScript] = useState(false)
  const status = workflowStatusStyle(detail.status)
  const active = isWorkflowActive(detail.status)
  const groups = groupAgentsByPhase(detail)
  const progress = agentProgress(detail.agentCounts)
  const canStop = active && detail.controllable !== false

  return (
    <div className="flex flex-col gap-3">
      {/* Title + status */}
      <div className="flex items-start gap-2">
        <WorkflowIcon className="mt-0.5 size-4 shrink-0 text-violet-400" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground" title={detail.workflowName}>
              {detail.workflowName}
            </h3>
            <Badge variant="outline" className={cn("h-5 gap-1 px-1.5 text-[10px] font-semibold", status.badge)}>
              {active && <span className={cn("size-1.5 animate-pulse rounded-full", status.dot)} />}
              {status.label}
            </Badge>
          </div>
          {detail.summary && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail.summary}</p>
          )}
        </div>
      </div>

      {/* Force-stop */}
      {active && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!canStop || stopping}
            onClick={onForceStop}
            className={cn(
              "h-7 gap-1.5 border-red-700/50 text-red-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50",
              confirming && "bg-red-500/15 text-red-300",
            )}
          >
            {stopping ? <Loader2 className="size-3 animate-spin" /> : <Octagon className="size-3" />}
            {confirming ? "Confirm stop" : "Force stop"}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {!canStop
              ? "Runs in an external session Cogpit can't control"
              : confirming
                ? "Click again to stop the session running this workflow"
                : "Stops the session running this workflow"}
          </span>
        </div>
      )}

      {/* Meta strip */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/50 bg-elevation-1 px-2.5 py-2 text-[11px] text-muted-foreground">
        <Stat icon={Bot} label={`${detail.agentCounts.done + detail.agentCounts.error}/${detail.agentCount} agents`} />
        <Stat icon={Layers} label={`${detail.phaseCount} phase${detail.phaseCount === 1 ? "" : "s"}`} />
        {detail.totalTokens > 0 && <Stat icon={Coins} label={formatTokens(detail.totalTokens)} />}
        {detail.totalToolCalls > 0 && <Stat icon={Wrench} label={`${detail.totalToolCalls} tools`} />}
        {typeof detail.durationMs === "number" && <Stat icon={Clock} label={formatDuration(detail.durationMs)} />}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevation-1">
        <div
          className={cn("h-full rounded-full transition-all", detail.agentCounts.error > 0 ? "bg-amber-500" : active ? "bg-blue-500" : "bg-emerald-500")}
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>

      {/* Error */}
      {detail.error && (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-red-900/40 bg-red-500/5 p-2 text-[10px] text-red-300">
          {detail.error}
        </pre>
      )}

      {/* Phases → agents */}
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <section key={`${group.index}-${group.title}`}>
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="flex size-4 items-center justify-center rounded bg-violet-500/15 text-[9px] font-bold text-violet-300">
                {group.index}
              </span>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.title}
              </h4>
              <span className="text-[10px] text-muted-foreground/70">{group.agents.length}</span>
            </div>
            {group.agents.length === 0 ? (
              <p className="pl-5 text-[10px] italic text-muted-foreground/60">No agents yet</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {group.agents.map((agent) => (
                  <WorkflowAgentCard key={agent.agentId || agent.index} agent={agent} />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      {/* Orchestration script (read-only) */}
      {detail.script && (
        <div className="border-t border-border/40 pt-2">
          <button
            onClick={() => setShowScript((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronRight className={cn("size-3 transition-transform", showScript && "rotate-90")} />
            <Code2 className="size-3" />
            Orchestration script
          </button>
          {showScript && (
            <pre className="mt-1.5 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-elevation-0 p-2.5 text-[10px] leading-relaxed text-muted-foreground">
              {detail.script}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ icon: Icon, label }: { icon: typeof Bot; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="size-3" />
      {label}
    </span>
  )
}
