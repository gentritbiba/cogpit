import { useCallback, useEffect, useState } from "react"
import { Workflow as WorkflowIcon, RefreshCw, Loader2, ChevronLeft } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import { formatRelativeTime } from "@/lib/format"
import { useWorkflowLive } from "@/hooks/useWorkflowLive"
import {
  isWorkflowActive,
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
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [detail, setDetail] = useState<WorkflowDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [stopNote, setStopNote] = useState<string | null>(null)

  // Default selection: newest run, kept sticky unless it disappears.
  useEffect(() => {
    if (workflows.length === 0) {
      setSelectedRunId(null)
      return
    }
    setSelectedRunId((cur) =>
      cur && workflows.some((w) => w.runId === cur) ? cur : workflows[0].runId,
    )
  }, [workflows])

  const fetchDetail = useCallback(async () => {
    if (!dirName || !sessionId || !selectedRunId) {
      setDetail(null)
      return
    }
    try {
      const res = await authFetch(
        `/api/workflow-detail/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(selectedRunId)}`,
      )
      if (!res.ok) {
        setDetail(null)
        return
      }
      setDetail(await res.json())
    } catch {
      setDetail(null)
    } finally {
      setLoadingDetail(false)
    }
  }, [dirName, sessionId, selectedRunId])

  // Fetch detail when the selected run changes.
  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null)
      return
    }
    setLoadingDetail(true)
    setConfirmingStop(false)
    setStopNote(null)
    fetchDetail()
  }, [selectedRunId, fetchDetail])

  // Live updates for the selected run: refetch its detail and the list.
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
        setStopNote("Couldn't stop — the session may have already exited.")
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

  const showList = workflows.length > 1
  const selected = workflows.find((w) => w.runId === selectedRunId)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="!max-w-[820px] w-full">
        <SheetHeader>
          <div className="flex items-center justify-between pr-8">
            <SheetTitle className="flex items-center gap-2">
              <WorkflowIcon className="size-4 text-violet-400" />
              Workflows
              {isLive && (
                <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px] font-semibold border-green-700 text-green-400">
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-green-500" />
                  </span>
                  LIVE
                </Badge>
              )}
            </SheetTitle>
            <button
              onClick={onRefetchList}
              aria-label="Refresh workflows"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-elevation-1 hover:text-foreground transition-colors"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
        </SheetHeader>

        <ScrollArea className="h-[calc(100dvh-4.5rem)]">
          <div className="px-4 pb-10 pt-2">
            {workflows.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-20 text-center text-muted-foreground">
                <WorkflowIcon className="size-8 opacity-40" />
                <p className="text-sm">No workflows in this session</p>
                <p className="max-w-xs text-xs text-muted-foreground/70">
                  When this session launches a workflow, its phases and agents will appear here live.
                </p>
              </div>
            ) : (
              <>
                {/* Run selector (only when more than one) */}
                {showList && (
                  <div className="mb-3 flex flex-col gap-1">
                    {selectedRunId && detail && (
                      <button
                        onClick={() => setSelectedRunId(null)}
                        className="mb-1 inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        <ChevronLeft className="size-3" />
                        All workflows ({workflows.length})
                      </button>
                    )}
                    {(!selectedRunId || !detail) &&
                      workflows.map((w) => (
                        <WorkflowListRow
                          key={w.runId}
                          workflow={w}
                          active={w.runId === selectedRunId}
                          onClick={() => setSelectedRunId(w.runId)}
                        />
                      ))}
                  </div>
                )}

                {/* Detail */}
                {loadingDetail && !detail ? (
                  <div className="flex items-center justify-center py-20">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : detail ? (
                  <>
                    {stopNote && (
                      <div className="mb-2 rounded-md border border-border/50 bg-elevation-1 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                        {stopNote}
                      </div>
                    )}
                    <WorkflowDetailView
                      detail={detail}
                      stopping={stopping}
                      confirming={confirmingStop}
                      onForceStop={handleForceStop}
                    />
                  </>
                ) : selected ? (
                  <p className="py-20 text-center text-sm text-muted-foreground">Couldn't load this workflow.</p>
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
  const live = isWorkflowActive(workflow.status)
  const done = workflow.agentCounts.done + workflow.agentCounts.error
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors",
        active ? "border-violet-700/50 bg-violet-500/10" : "border-border/50 bg-elevation-1 hover:bg-elevation-2",
      )}
    >
      <span className={cn("size-2 shrink-0 rounded-full", status.dot, live && "animate-pulse")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium text-foreground">{workflow.workflowName}</span>
          <Badge variant="outline" className={cn("h-4 px-1.5 text-[9px] font-semibold uppercase", status.badge)}>
            {status.label}
          </Badge>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{done}/{workflow.agentCount} agents</span>
          {workflow.startTime > 0 && <span>{formatRelativeTime(new Date(workflow.startTime).toISOString())}</span>}
        </div>
      </div>
    </button>
  )
}
