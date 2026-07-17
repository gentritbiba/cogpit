import { useState, useEffect, useCallback } from "react"
import { authFetch } from "@/lib/auth"

export type PermissionDecision = "allow" | "allow_always" | "deny"

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  suggestions?: Array<Record<string, unknown>>
  timestamp: number
  /** Decisions this provider allows for this exact request. Omitted by legacy providers. */
  availableDecisions?: PermissionDecision[]
}

// Permission requests need to feel responsive, but this poll must not become a
// render clock for the entire session tree. Electron also throttles the window
// in the background, and we skip polling entirely while the document is hidden.
const POLL_INTERVAL = 2_000

function permissionRequestsEqual(
  current: PermissionRequest[],
  next: PermissionRequest[],
): boolean {
  if (current.length !== next.length) return false
  return JSON.stringify(current) === JSON.stringify(next)
}

export function usePermissionRequests(
  sessionId: string | null,
  _permissionMode: string | undefined,
) {
  const [requests, setRequests] = useState<PermissionRequest[]>([])
  const [responding, setResponding] = useState<Set<string>>(new Set())

  // Access mode controls future tool calls. An approval already issued by a
  // provider remains pending until the user explicitly answers it.
  useEffect(() => {
    if (!sessionId) {
      setRequests([])
      return
    }

    let cancelled = false

    const poll = async () => {
      if (cancelled) return
      try {
        const res = await authFetch(`/api/permissions/${encodeURIComponent(sessionId)}`)
        if (cancelled) return
        if (res.ok) {
          const data = await res.json() as { permissions: PermissionRequest[] }
          setRequests((current) => (
            permissionRequestsEqual(current, data.permissions)
              ? current
              : data.permissions
          ))
        }
      } catch {
        // ignore
      }
    }

    const pollWhenVisible = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void poll()
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll()
    }

    pollWhenVisible()
    const id = setInterval(pollWhenVisible, POLL_INTERVAL)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [sessionId])

  const respond = useCallback(async (
    requestId: string,
    behavior: PermissionDecision,
  ) => {
    if (!sessionId) return

    setResponding((prev) => new Set(prev).add(requestId))

    try {
      const res = await authFetch(`/api/permissions/${encodeURIComponent(sessionId)}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, behavior }),
      })
      if (res.ok) {
        setRequests((prev) => prev.filter((r) => r.requestId !== requestId))
      }
    } finally {
      setResponding((prev) => {
        const next = new Set(prev)
        next.delete(requestId)
        return next
      })
    }
  }, [sessionId])

  const respondAll = useCallback(async (behavior: PermissionDecision) => {
    if (!sessionId) return

    try {
      const res = await authFetch(`/api/permissions/${encodeURIComponent(sessionId)}/respond-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior }),
      })
      if (res.ok) {
        setRequests([])
      }
    } catch {
      // ignore
    }
  }, [sessionId])

  return { requests, responding, respond, respondAll }
}
