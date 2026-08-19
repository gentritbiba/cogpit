import { useCallback, useEffect, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"
import { useWorkflowLive } from "./useWorkflowLive"
import type { WorkflowSummary } from "@/lib/workflow-types"

export interface SessionWorkflows {
  workflows: WorkflowSummary[]
  loading: boolean
  isLive: boolean
  refetch: () => void
}

/**
 * Loads the list of workflows for a session and keeps it live via SSE.
 * Returns an empty list (no error) when the session has never run a workflow.
 *
 * The list is discovered once whenever a top-level session opens. `liveHint`
 * starts the watcher immediately when the transcript contains a Workflow call;
 * older runs also start watching after discovery.
 */
export function useSessionWorkflows(
  dirName: string | null,
  sessionId: string | null,
  liveHint: boolean = true,
): SessionWorkflows {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [loading, setLoading] = useState(false)
  const requestIdRef = useRef(0)

  const active = !!dirName && !!sessionId

  const fetchList = useCallback(async () => {
    const requestId = ++requestIdRef.current
    if (!active) {
      setWorkflows([])
      return
    }
    try {
      const res = await authFetch(
        `/api/workflows/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}`,
      )
      if (!res.ok) {
        if (requestId === requestIdRef.current) setWorkflows([])
        return
      }
      const data: WorkflowSummary[] = await res.json()
      if (requestId === requestIdRef.current) {
        setWorkflows(Array.isArray(data) ? data : [])
      }
    } catch {
      if (requestId === requestIdRef.current) setWorkflows([])
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [active, dirName, sessionId])

  useEffect(() => {
    if (!active) {
      setWorkflows([])
      setLoading(false)
      return
    }
    setLoading(true)
    fetchList()
  }, [active, fetchList])

  const watch = active && (liveHint || workflows.length > 0)
  const { isLive } = useWorkflowLive(
    watch ? dirName : null,
    watch ? sessionId : null,
    null,
    fetchList,
  )

  return { workflows, loading, isLive, refetch: fetchList }
}
