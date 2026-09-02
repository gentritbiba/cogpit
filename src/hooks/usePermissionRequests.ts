import { useState, useEffect, useCallback } from "react"
import { authFetch } from "@/lib/auth"
import {
  respondToAllPermissions,
  respondToPermission,
  type PermissionDecision,
} from "@/lib/permissionApi"
import type { PlanApprovalState } from "../../shared/session/interactiveState"

export type { PermissionDecision }

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

export function usePermissionRequests(sessionId: string | null) {
  const [requests, setRequests] = useState<PermissionRequest[]>([])
  const [plan, setPlan] = useState<PlanApprovalState | null>(null)
  const [responding, setResponding] = useState<Set<string>>(new Set())

  // Access mode controls future tool calls. An approval already issued by a
  // provider remains pending until the user explicitly answers it.
  useEffect(() => {
    if (!sessionId) {
      setRequests([])
      setPlan(null)
      return
    }

    let cancelled = false

    const poll = async () => {
      if (cancelled) return
      try {
        const res = await authFetch(`/api/permissions/${encodeURIComponent(sessionId)}`)
        if (cancelled) return
        if (res.ok) {
          const data = await res.json() as {
            permissions: PermissionRequest[]
            plan?: {
              requestId: string
              summary: string
              planContent?: string
              actions: string[]
              recommendedAction: string
            } | null
          }
          if (cancelled) return
          setRequests((current) => (
            permissionRequestsEqual(current, data.permissions)
              ? current
              : data.permissions
          ))
          const nextPlan: PlanApprovalState | null = data.plan
            ? { type: "plan", provider: "copilot", ...data.plan }
            : null
          setPlan((current) => (
            JSON.stringify(current) === JSON.stringify(nextPlan) ? current : nextPlan
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
      if (await respondToPermission(sessionId, requestId, behavior)) {
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
      if (await respondToAllPermissions(sessionId, behavior)) {
        setRequests([])
      }
    } catch {
      // ignore
    }
  }, [sessionId])

  return { requests, plan, responding, respond, respondAll }
}
