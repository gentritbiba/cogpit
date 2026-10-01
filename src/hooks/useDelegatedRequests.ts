import { useCallback, useEffect, useState } from "react"
import { authFetch, jsonFetch } from "@/lib/auth"
import { useVisiblePolling } from "@/hooks/useVisiblePolling"
import type { DelegatedRequest } from "../../shared/contracts/delegatedRequests"
import type { PendingInputResponse } from "../../shared/contracts/pendingInput"

const POLL_INTERVAL = 3_000

/**
 * What the sessions this one handed work to are asking the user — permission
 * prompts, questions and plan approvals from delegated sessions, on this
 * machine or another device. Polled only while the tab is visible.
 */
export function useDelegatedRequests(parentSessionId: string | null) {
  const [requests, setRequests] = useState<DelegatedRequest[]>([])
  const [responding, setResponding] = useState<Set<string>>(new Set())

  const poll = useCallback(async (isActive: () => boolean) => {
    if (!parentSessionId) return
    try {
      const res = await authFetch(`/api/session-requests?parent=${encodeURIComponent(parentSessionId)}`)
      if (!isActive() || !res.ok) return
      const data = await res.json() as { requests: DelegatedRequest[] }
      if (!isActive()) return
      setRequests((current) => (JSON.stringify(current) === JSON.stringify(data.requests) ? current : data.requests))
    } catch {
      // The next poll retries.
    }
  }, [parentSessionId])
  useVisiblePolling(parentSessionId ? poll : null, POLL_INTERVAL)
  // Another session's prompts must not linger while this one's first poll runs.
  useEffect(() => {
    setRequests([])
  }, [parentSessionId])

  const respond = useCallback(async (sessionId: string, requestId: string, response: PendingInputResponse) => {
    setResponding((prev) => new Set(prev).add(requestId))
    try {
      const res = await jsonFetch("/api/session-respond", { sessionId, requestId, ...response })
      if (res.ok || res.status === 404) {
        // Answered now, or already answered elsewhere; either way it is gone.
        setRequests((prev) => prev
          .map((request) => request.sessionId === sessionId
            ? { ...request, waiting: request.waiting.filter((pending) => pending.requestId !== requestId) }
            : request)
          .filter((request) => request.waiting.length > 0))
      }
    } finally {
      setResponding((prev) => {
        const next = new Set(prev)
        next.delete(requestId)
        return next
      })
    }
  }, [])

  return { requests, responding, respond }
}
