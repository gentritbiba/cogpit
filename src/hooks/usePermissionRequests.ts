import { useState, useEffect, useCallback, useRef } from "react"
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

const POLL_INTERVAL = 600

export function usePermissionRequests(
  sessionId: string | null,
  _permissionMode: string | undefined,
) {
  const [requests, setRequests] = useState<PermissionRequest[]>([])
  const [responding, setResponding] = useState<Set<string>>(new Set())
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  // Access mode controls future tool calls. An approval already issued by a
  // provider remains pending until the user explicitly answers it.
  useEffect(() => {
    if (!sessionId) {
      setRequests([])
      return
    }

    let cancelled = false

    const poll = async () => {
      if (cancelled || !sessionIdRef.current) return
      try {
        const res = await authFetch(`/api/permissions/${encodeURIComponent(sessionIdRef.current)}`)
        if (cancelled) return
        if (res.ok) {
          const data = await res.json() as { permissions: PermissionRequest[] }
          setRequests(data.permissions)
        }
      } catch {
        // ignore
      }
    }

    poll()
    const id = setInterval(poll, POLL_INTERVAL)
    return () => { cancelled = true; clearInterval(id) }
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
