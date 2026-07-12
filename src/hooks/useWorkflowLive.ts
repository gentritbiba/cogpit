import { useEffect, useRef, useState } from "react"
import { authUrl } from "@/lib/auth"

/**
 * Subscribe to SSE workflow updates for a session (or a specific run).
 * Mirrors useTeamLive: the server emits {type:"update"} on debounced fs
 * changes; we call onUpdate to refetch and track a live indicator.
 *
 * @param runId  when provided, watch only that run; otherwise watch the whole
 *               session for new/changed workflows.
 */
export function useWorkflowLive(
  dirName: string | null,
  sessionId: string | null,
  runId: string | null,
  onUpdate: () => void,
): { isLive: boolean } {
  const [isLive, setIsLive] = useState(false)
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  useEffect(() => {
    if (!dirName || !sessionId) {
      setIsLive(false)
      return
    }

    let url = `/api/workflow-watch/${encodeURIComponent(dirName)}/${encodeURIComponent(sessionId)}`
    if (runId) url += `/${encodeURIComponent(runId)}`

    const es = new EventSource(authUrl(url))
    let staleTimer: ReturnType<typeof setTimeout> | null = null

    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => setIsLive(false), 30000)
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === "init") {
          resetStaleTimer()
        } else if (data.type === "update") {
          setIsLive(true)
          resetStaleTimer()
          onUpdateRef.current()
        }
      } catch {
        // ignore malformed events
      }
    }

    es.onerror = () => {
      setIsLive(false)
    }

    return () => {
      es.close()
      setIsLive(false)
      if (staleTimer) clearTimeout(staleTimer)
    }
  }, [dirName, sessionId, runId])

  return { isLive }
}
