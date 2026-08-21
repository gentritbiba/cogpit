import { useCallback, useState } from "react"
import {
  Check,
  ChevronDown,
  Clock,
  Coins,
  Copy,
  FileText,
  RotateCcw,
  Wrench,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
  agentStateStyle,
  formatTokens,
  isTerminalAgentState,
  type WorkflowAgent,
} from "@/lib/workflow-types"
import {
  responseSummary,
  serializeWorkflowResponse,
  WorkflowResponse,
} from "./WorkflowResponse"

type ResultState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; value: unknown }
  | { status: "unavailable" }

interface WorkflowAgentCardProps {
  agent: WorkflowAgent
  dirName: string
  sessionId: string
  runId: string
}

function cleanModelName(model: string): string {
  return model.replace(/\[[0-9;]*m\]/g, "")
}

function readableAgentName(label: string): string {
  const name = label.includes(":") ? label.slice(label.indexOf(":") + 1) : label
  return name.replace(/[-_]+/g, " ")
}

export function WorkflowAgentCard({ agent, dirName, sessionId, runId }: WorkflowAgentCardProps) {
  const [open, setOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [resultState, setResultState] = useState<ResultState>({ status: "idle" })
  const [copied, copy] = useCopyWithFeedback()
  const style = agentStateStyle(agent.state)
  const running = !isTerminalAgentState(agent.state) && agent.state !== "queued"
  const summary = agent.resultPreview ? responseSummary(agent.resultPreview) : ""

  const loadFullResult = useCallback(async () => {
    setResultState({ status: "loading" })
    try {
      const response = await authFetch(
        `/api/workflow-agent-result/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(runId)}/${encodeURIComponent(agent.agentId)}`,
      )
      if (!response.ok) {
        setResultState({ status: "unavailable" })
        return
      }
      const data = await response.json() as { result?: unknown }
      setResultState({ status: "loaded", value: data.result })
    } catch {
      setResultState({ status: "unavailable" })
    }
  }, [agent.agentId, dirName, runId, sessionId])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen && resultState.status === "idle" && isTerminalAgentState(agent.state)) {
      void loadFullResult()
    }
  }

  const visibleResult = resultState.status === "loaded" ? resultState.value : agent.resultPreview
  const canRetry = resultState.status === "unavailable"

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <Card size="sm" className="motion-card motion-list-item gap-0 py-0">
        <CardHeader className="px-0 py-0">
          <CollapsibleTrigger className="group flex w-full items-start gap-3 rounded-lg px-3.5 py-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50">
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", style.dot)} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <CardTitle className="truncate capitalize" title={agent.label}>
                  {readableAgentName(agent.label)}
                </CardTitle>
                {agent.attempt && agent.attempt > 1 && (
                  <Badge variant="outline" className="text-muted-foreground">
                    Attempt {agent.attempt}
                  </Badge>
                )}
              </div>
              {summary ? (
                <p className="mt-1 line-clamp-2 max-w-3xl text-xs leading-relaxed text-muted-foreground">
                  {summary}
                </p>
              ) : running && agent.lastToolName ? (
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  Working in {agent.lastToolName}
                  {agent.lastToolSummary ? `: ${agent.lastToolSummary}` : ""}
                </p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {agent.model && <span>{cleanModelName(agent.model)}</span>}
                {typeof agent.tokens === "number" && agent.tokens > 0 && (
                  <Metric icon={Coins}>{formatTokens(agent.tokens)} tokens</Metric>
                )}
                {typeof agent.toolCalls === "number" && agent.toolCalls > 0 && (
                  <Metric icon={Wrench}>{agent.toolCalls} tools</Metric>
                )}
                {typeof agent.durationMs === "number" && (
                  <Metric icon={Clock}>{formatDuration(agent.durationMs)}</Metric>
                )}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="outline" className={cn("hidden sm:inline-flex", style.badge)}>
                {running && <Spinner data-icon="inline-start" />}
                {style.label}
              </Badge>
              <ChevronDown className="mt-0.5 size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none" />
            </div>
          </CollapsibleTrigger>
        </CardHeader>

        <CollapsibleContent>
          <Separator />
          <CardContent className="flex flex-col gap-4 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h5 className="text-sm font-semibold text-foreground">Response</h5>
                <p className="text-xs text-muted-foreground">
                  {resultState.status === "loaded" ? "Complete agent response" : "Saved response preview"}
                </p>
              </div>
              <div className="flex items-center gap-1">
                {canRetry && (
                  <Button variant="ghost" size="sm" onClick={() => void loadFullResult()}>
                    <RotateCcw data-icon="inline-start" />
                    Retry
                  </Button>
                )}
                {visibleResult !== undefined && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => copy(serializeWorkflowResponse(visibleResult))}
                    aria-label={copied ? "Response copied" : "Copy response"}
                    title={copied ? "Copied" : "Copy response"}
                  >
                    {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                  </Button>
                )}
              </div>
            </div>

            {resultState.status === "loading" ? (
              <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
                <Spinner />
                Loading the complete response…
              </div>
            ) : visibleResult !== undefined ? (
              <WorkflowResponse value={visibleResult} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {running ? "This agent has not returned a response yet." : "No response was saved for this agent."}
              </p>
            )}

            {agent.promptPreview && (
              <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
                <CollapsibleTrigger
                  render={<Button variant="ghost" size="sm" className="w-full justify-start" />}
                >
                  <FileText data-icon="inline-start" />
                  Agent prompt
                  <ChevronDown data-icon="inline-end" className={cn("ml-auto transition-transform", promptOpen && "rotate-180")} />
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <div className="rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                    <WorkflowResponse value={agent.promptPreview} />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}

function Metric({ icon: Icon, children }: { icon: typeof Coins; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className="size-3" />
      {children}
    </span>
  )
}
