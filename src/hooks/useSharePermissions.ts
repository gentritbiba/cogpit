import { useCallback, useState } from "react"
import type { PermissionDecision, PermissionRequest } from "@/hooks/usePermissionRequests"
import { fetchSharePending, respondSharePermission } from "@/lib/shareApi"
import { useVisiblePolling } from "@/hooks/useVisiblePolling"

/**
 * The guest's view of what the shared session is blocked on.
 *
 * {@link usePermissionRequests} polls `/api/permissions/:sessionId`, which names
 * a session in the path and is therefore denied to a guest. This reads the
 * token-scoped `/api/share/pending` instead and returns the same shape, so the
 * permission bar renders unchanged.
 */
const POLL_INTERVAL = 2_000

function requestsEqual(current: PermissionRequest[], next: PermissionRequest[]): boolean {
  if (current.length !== next.length) return false
  return JSON.stringify(current) === JSON.stringify(next)
}

export interface SharePermissions {
  requests: PermissionRequest[]
  responding: Set<string>
  respond: (requestId: string, behavior: PermissionDecision) => void
  respondAll: (behavior: PermissionDecision) => void
}

export function useSharePermissions(): SharePermissions {
  const [requests, setRequests] = useState<PermissionRequest[]>([])
  const [responding, setResponding] = useState<Set<string>>(new Set())

  const poll = useCallback(async (isActive: () => boolean) => {
    const next = await fetchSharePending()
    // A failed or refused read leaves the last list standing: a stale blocker
    // beats dropping one the guest must still answer.
    if (!isActive() || next === null) return
    setRequests((current) => (requestsEqual(current, next) ? current : next))
  }, [])
  useVisiblePolling(poll, POLL_INTERVAL)

  const respond = useCallback((requestId: string, behavior: PermissionDecision) => {
    setResponding((prev) => new Set(prev).add(requestId))
    void respondSharePermission(requestId, behavior)
      .then((accepted) => {
        if (accepted) setRequests((prev) => prev.filter((r) => r.requestId !== requestId))
      })
      .finally(() => {
        setResponding((prev) => {
          const next = new Set(prev)
          next.delete(requestId)
          return next
        })
      })
  }, [])

  /**
   * One call per request rather than a bulk endpoint. The guest namespace
   * answers exactly one requestId at a time by design — nothing in a guest body
   * may widen the blast radius of a single decision.
   */
  const respondAll = useCallback((behavior: PermissionDecision) => {
    for (const request of requests) respond(request.requestId, behavior)
  }, [requests, respond])

  return { requests, responding, respond, respondAll }
}
