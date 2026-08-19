import { useCallback, useEffect, useRef, useState } from "react"
import { Workflow as WorkflowIcon, RefreshCw, ChevronLeft } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/Spinner"
import { LiveIndicator } from "@/components/header-shared"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import { formatRelativeTime } from "@/lib/format"
import { useWorkflowLive } from "@/hooks/useWorkflowLive"
import {
  workflowStatusStyle,
  type WorkflowDetail,
  type WorkflowSummary,
} from "@/lib/workflow-types"
import { WorkflowDetailView } from "@/components/workflows/WorkflowDetailView"

interface WorkflowsPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dirName: string | null
  sessionId: string | null
  workflows: WorkflowSummary[]
  isLive: boolean
  onRefetchList: () => void
}

export function WorkflowsPanel({
  open,
  onOpenChange,
  dirName,
  sessionId,
  workflows,
  isLive,
  onRefetchList,
}: WorkflowsPanelProps) {
  const [preferredRunId, setPreferredRunId] = useState<string | null>(null)
  const [showRunList, setShowRunList] = useState(false)
  const [detail, setDetail] = useState<WorkflowDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [stopNote, setStopNote] = useState<string | null>(null)
  const detailRequestIdRef = useRef(0)

  const selectedRunId = showRunList
    ? null
    : preferredRunId && workflows.some((workflow) => workflow.runId === preferredRunId)
      ? preferredRunId
      : workflows[0]?.runId ?? null

  const fetchDetail = useCallback(async () => {
    const requestId = ++detailRequestIdRef.current
    if (!dirName || !sessionId || !selectedRunId) {
      setDetail(null)
      return
    }
    try {
      const res = await authFetch(
        `/api/workflow-detail/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(selectedRunId)}`,
      )
      if (!res.ok) {
        if (requestId === detailRequestIdRef.current) setDetail(null)
        return
      }
      const nextDetail = await res.json() as WorkflowDetail
      if (requestId === detailRequestIdRef.current) setDetail(nextDetail)
    } catch {
      if (requestId === detailRequestIdRef.current) setDetail(null)
    } finally {
      if (requestId === detailRequestIdRef.current) setLoadingDetail(false)
    }
  }, [dirName, sessionId, selectedRunId])

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null)
      return
    }
    setDetail(null)
    setLoadingDetail(true)
    setConfirmingStop(false)
    setStopNote(null)
    fetchDetail()
  }, [selectedRunId, fetchDetail])

  useWorkflowLive(open ? dirName : null, open ? sessionId : null, open ? selectedRunId : null, () => {
    fetchDetail()
    onRefetchList()
  })

  const handleForceStop = useCallback(async () => {
    if (!confirmingStop) {
      setConfirmingStop(true)
      return
    }
    if (!sessionId || !selectedRunId) return
    setStopping(true)
    setStopNote(null)
    try {
      const res = await authFetch("/api/workflow-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, runId: selectedRunId }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.success) {
        setStopNote("Stop signal sent.")
      } else if (data?.controllable === false) {
        setStopNote("This workflow runs in a session Cogpit doesn't control.")
      } else {
        setStopNote("Couldn't stop. The session may have already exited.")
      }
      fetchDetail()
      onRefetchList()
    } catch {
      setStopNote("Stop request failed.")
    } finally {
      setStopping(false)
      setConfirmingStop(false)
    }
  }, [confirmingStop, sessionId, selectedRunId, fetchDetail, onRefetchList])

  const hasMultipleRuns = workflows.length > 1
  const selected = workflows.find((w) => w.runId === selectedRunId)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full data-[side=right]:max-w-[1120px]">
        <SheetHeader className="min-h-14 justify-center border-b py-3">
          <div className="flex items-center justify-between gap-3 pr-9">
            <SheetTitle className="flex items-center gap-2">
              <WorkflowIcon className="size-4" />
              Workflows
              {workflows.length > 0 && (
                <Badge variant="secondary">{workflows.length}</Badge>
              )}
              {isLive && (
                <Badge variant="outline" className="border-info/30 text-info">
                  <LiveIndicator className="size-1.5" />
                  Live
                </Badge>
              )}
            </SheetTitle>
            <SheetDescription className="sr-only">
              Inspect workflow runs, agent progress, and run controls for this session.
            </SheetDescription>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRefetchList}
              aria-label="Refresh workflows"
              title="Refresh workflows"
            >
              <RefreshCw data-icon="inline-start" />
            </Button>
          </div>
        </SheetHeader>

        <ScrollArea className="h-[calc(100dvh-3.5rem)]">
          <div className="px-5 py-6 sm:px-6">
            {workflows.length === 0 ? (
              <Empty className="min-h-[60dvh]">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><WorkflowIcon /></EmptyMedia>
                  <EmptyTitle>No workflows in this session</EmptyTitle>
                  <EmptyDescription>
                    Phases, agents, and their responses will appear here when this session starts a workflow.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                {hasMultipleRuns && (
                  <div className="mb-6 flex flex-col gap-2">
                    {selectedRunId && detail && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowRunList(true)}
                        className="w-fit px-2 text-muted-foreground"
                      >
                        <ChevronLeft data-icon="inline-start" />
                        All runs
                      </Button>
                    )}
                    {(!selectedRunId || !detail) &&
                      workflows.map((w) => (
                        <WorkflowListRow
                          key={w.runId}
                          workflow={w}
                          active={w.runId === selectedRunId}
                          onClick={() => {
                            setPreferredRunId(w.runId)
                            setShowRunList(false)
                          }}
                        />
                      ))}
                  </div>
                )}

                {loadingDetail && !detail ? (
                  <div className="flex min-h-[50dvh] items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Spinner />
                    Loading workflow…
                  </div>
                ) : detail ? (
                  <>
                    {stopNote && (
                      <Alert className="mb-4">
                        <AlertDescription>{stopNote}</AlertDescription>
                      </Alert>
                    )}
                    <WorkflowDetailView
                      detail={detail}
                      dirName={dirName ?? ""}
                      sessionId={sessionId ?? ""}
                      stopping={stopping}
                      confirming={confirmingStop}
                      onForceStop={handleForceStop}
                    />
                  </>
                ) : selected ? (
                  <Empty className="min-h-[50dvh]">
                    <EmptyHeader>
                      <EmptyTitle>Could not load this workflow</EmptyTitle>
                      <EmptyDescription>The journal may have moved or the run may no longer be available.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

function WorkflowListRow({
  workflow,
  active,
  onClick,
}: {
  workflow: WorkflowSummary
  active: boolean
  onClick: () => void
}) {
  const status = workflowStatusStyle(workflow.status)
  const done = workflow.agentCounts.done + workflow.agentCounts.error
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={cn(
        "h-auto w-full justify-start gap-3 whitespace-normal border px-3 py-3 text-left",
        active ? "border-foreground/20 bg-accent" : "bg-background hover:bg-muted/50",
      )}
    >
      <span className={cn("size-2 shrink-0 rounded-full", status.dot)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{workflow.workflowName}</span>
          <Badge variant="outline" className={status.badge}>
            {status.label}
          </Badge>
        </div>
        {workflow.summary && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{workflow.summary}</p>}
        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{done}/{workflow.agentCount} agents</span>
          {workflow.startTime > 0 && <span>{formatRelativeTime(new Date(workflow.startTime).toISOString())}</span>}
        </div>
      </div>
    </Button>
  )
}
