import { useCallback, useEffect, useState } from "react"
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
 * `enabled` gates all I/O: pass false for sessions that never used the
 * Workflow tool so we don't open an fs.watch on every opened session.
 */
export function useSessionWorkflows(
  dirName: string | null,
  sessionId: string | null,
  enabled: boolean = true,
): SessionWorkflows {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [loading, setLoading] = useState(false)

  const active = enabled && !!dirName && !!sessionId

  const fetchList = useCallback(async () => {
    if (!active) {
      setWorkflows([])
      return
    }
    try {
      const res = await authFetch(
        `/api/workflows/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}`,
      )
      if (!res.ok) {
        setWorkflows([])
        return
      }
      const data: WorkflowSummary[] = await res.json()
      setWorkflows(Array.isArray(data) ? data : [])
    } catch {
      setWorkflows([])
    } finally {
      setLoading(false)
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

  const { isLive } = useWorkflowLive(
    active ? dirName : null,
    active ? sessionId : null,
    null,
    fetchList,
  )

  return { workflows, loading, isLive, refetch: fetchList }
}
