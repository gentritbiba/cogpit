import { useCallback, useState } from "react"
import {
  Bot,
  Check,
  ChevronDown,
  Clock,
  Code2,
  Coins,
  Copy,
  Layers,
  Octagon,
  Sparkles,
  Wrench,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/Spinner"
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback"
import { authFetch } from "@/lib/auth"
import { formatDuration } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  agentProgress,
  formatTokens,
  groupAgentsByPhase,
  isWorkflowActive,
  workflowStatusStyle,
  type PhaseGroup,
  type WorkflowDetail,
} from "@/lib/workflow-types"
import { WorkflowAgentCard } from "./WorkflowAgentCard"
import { serializeWorkflowResponse, WorkflowResponse } from "./WorkflowResponse"

interface WorkflowDetailViewProps {
  detail: WorkflowDetail
  dirName: string
  sessionId: string
  stopping: boolean
  confirming: boolean
  onForceStop: () => void
}

export function WorkflowDetailView({
  detail,
  dirName,
  sessionId,
  stopping,
  confirming,
  onForceStop,
}: WorkflowDetailViewProps) {
  const status = workflowStatusStyle(detail.status)
  const active = isWorkflowActive(detail.status)
  const groups = groupAgentsByPhase(detail)
  const progress = agentProgress(detail.agentCounts)
  const canStop = active && detail.controllable !== false

  return (
    <div className="flex flex-col gap-6 pb-6">
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2">
              <Badge variant="outline" className={status.badge}>
                {active && <span className={cn("size-1.5 rounded-full", status.dot)} />}
                {status.label}
              </Badge>
              <span className="text-xs text-muted-foreground">Workflow run</span>
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground" title={detail.workflowName}>
              {detail.workflowName}
            </h2>
            {detail.summary && (
              <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                {detail.summary}
              </p>
            )}
          </div>

          {active && (
            <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
              <Button
                variant={confirming ? "destructive" : "outline"}
                size="sm"
                disabled={!canStop || stopping}
                onClick={onForceStop}
              >
                {stopping ? <Spinner data-icon="inline-start" /> : <Octagon data-icon="inline-start" />}
                {confirming ? "Confirm stop" : "Stop workflow"}
              </Button>
              {!canStop && (
                <span className="text-[11px] text-muted-foreground">This run is not controlled by Cogpit</span>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-5">
          <RunStat icon={Bot} value={`${detail.agentCounts.done + detail.agentCounts.error}/${detail.agentCount}`} label="Agents finished" />
          <RunStat icon={Layers} value={String(detail.phaseCount)} label="Phases" />
          <RunStat icon={Coins} value={formatTokens(detail.totalTokens)} label="Tokens" />
          <RunStat icon={Wrench} value={String(detail.totalToolCalls)} label="Tool calls" />
          <RunStat
            icon={Clock}
            value={typeof detail.durationMs === "number" ? formatDuration(detail.durationMs) : "In progress"}
            label="Duration"
            className="col-span-2 sm:col-span-1"
          />
        </div>

        <div className="flex items-center gap-3">
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Workflow progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width]",
                detail.agentCounts.error > 0 ? "bg-destructive" : active ? "bg-primary" : "bg-emerald-500",
              )}
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
            {Math.round(progress * 100)}%
          </span>
        </div>
      </section>

      {detail.error && (
        <Card size="sm" className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle>Workflow error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs text-destructive">
              {detail.error}
            </pre>
          </CardContent>
        </Card>
      )}

      {detail.resultPreview && (
        <WorkflowOutcomeCard
          preview={detail.resultPreview}
          dirName={dirName}
          sessionId={sessionId}
          runId={detail.runId}
        />
      )}

      <div className="grid items-start gap-6 md:grid-cols-[180px_minmax(0,1fr)]">
        <nav className="sticky top-0 hidden rounded-lg border bg-card p-2 md:block" aria-label="Workflow phases">
          <p className="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Run outline
          </p>
          <div className="flex flex-col gap-1">
            {groups.map((group) => (
              <button
                key={`${group.index}-${group.title}`}
                type="button"
                onClick={() => document.getElementById(`workflow-phase-${group.index}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[10px] font-semibold text-foreground">
                  {group.index}
                </span>
                <span className="min-w-0 flex-1 truncate">{group.title}</span>
                <span className="tabular-nums">{group.agents.length}</span>
              </button>
            ))}
          </div>
        </nav>

        <div className="flex min-w-0 flex-col gap-8">
          {groups.map((group) => (
            <PhaseSection
              key={`${group.index}-${group.title}`}
              group={group}
              dirName={dirName}
              sessionId={sessionId}
              runId={detail.runId}
            />
          ))}
        </div>
      </div>

      {detail.script && <WorkflowScript script={detail.script} />}
    </div>
  )
}

function RunStat({
  icon: Icon,
  value,
  label,
  className,
}: {
  icon: typeof Bot
  value: string
  label: string
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-2.5 bg-card px-3 py-3", className)}>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tabular-nums text-foreground">{value}</p>
        <p className="truncate text-[10px] text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

function PhaseSection({
  group,
  dirName,
  sessionId,
  runId,
}: {
  group: PhaseGroup
  dirName: string
  sessionId: string
  runId: string
}) {
  const completed = group.agents.filter((agent) => agent.state === "done" || agent.state === "skipped").length

  return (
    <section id={`workflow-phase-${group.index}`} className="scroll-mt-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
          {group.index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-base font-semibold text-foreground">{group.title}</h3>
            <span className="text-xs text-muted-foreground">
              {completed}/{group.agents.length} complete
            </span>
          </div>
          {group.detail && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{group.detail}</p>}
        </div>
      </div>

      {group.agents.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No agents have started this phase.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {group.agents.map((agent) => (
            <WorkflowAgentCard
              key={`${runId}:${agent.agentId || agent.index}`}
              agent={agent}
              dirName={dirName}
              sessionId={sessionId}
              runId={runId}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function WorkflowOutcomeCard({
  preview,
  dirName,
  sessionId,
  runId,
}: {
  preview: string
  dirName: string
  sessionId: string
  runId: string
}) {
  const [open, setOpen] = useState(true)
  const [fullResult, setFullResult] = useState<unknown>()
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [copied, copy] = useCopyWithFeedback()
  const previewIsShortened = preview.endsWith("…")
  const result = fullResult ?? preview

  const loadFullResult = useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    try {
      const response = await authFetch(
        `/api/workflow-result/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}`,
      )
      if (!response.ok) {
        setLoadFailed(true)
        return
      }
      const data = await response.json() as { result?: unknown }
      setFullResult(data.result)
    } catch {
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }, [dirName, runId, sessionId])

  return (
    <Card className="gap-0 py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="py-4">
          <CollapsibleTrigger className="group flex min-w-0 items-center gap-3 text-left outline-none">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles className="size-4" />
            </span>
            <span className="min-w-0">
              <CardTitle>Workflow outcome</CardTitle>
              <CardDescription>The synthesized answer from this run</CardDescription>
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
          <CardAction className="flex items-center gap-1">
            {previewIsShortened && fullResult === undefined && (
              <Button variant="outline" size="sm" disabled={loading} onClick={() => void loadFullResult()}>
                {loading && <Spinner data-icon="inline-start" />}
                {loadFailed ? "Retry full result" : "Load full result"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => copy(serializeWorkflowResponse(result))}
              aria-label={copied ? "Outcome copied" : "Copy outcome"}
              title={copied ? "Copied" : "Copy outcome"}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          <Separator />
          <CardContent className="py-5">
            <WorkflowResponse value={result} />
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

function WorkflowScript({ script }: { script: string }) {
  const [open, setOpen] = useState(false)

  return (
    <Card size="sm" className="gap-0 py-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader className="px-0 py-0">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-3 text-left text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/40 hover:text-foreground">
            <Code2 className="size-4" />
            Orchestration script
            <ChevronDown className="ml-auto size-4 transition-transform group-data-panel-open:rotate-180" />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <Separator />
          <CardContent className="py-3">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
              {script}
            </pre>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}
