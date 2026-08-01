/**
 * Card summaries and cross-session permission requests for Mission Control.
 *
 * One poll covers every card. The alternative — mounting the per-session
 * permission hook once per card — would issue N polls every two seconds.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"
import { respondToPermission, type PermissionDecision } from "@/lib/permissionApi"
import type {
  MissionControlPermission,
  MissionControlResponse,
  MissionControlSummary,
} from "../../shared/contracts/missionControl"

/**
 * A blocked agent is stopped dead, so this polls faster than the 20 s session
 * inventory. It stays idle while the tab is hidden and while the view is
 * closed, so a background window costs nothing.
 */
const POLL_INTERVAL = 3_000

export interface MissionControlData {
  summaries: Map<string, MissionControlSummary>
  permissionsBySession: Map<string, MissionControlPermission[]>
  /** Session ids with at least one live request — feeds classifyAttention. */
  awaitingPermission: Set<string>
  loading: boolean
  error: string | null
  /** Request ids currently being answered. */
  responding: Set<string>
  respond: (
    sessionId: string,
    requestId: string,
    behavior: PermissionDecision,
  ) => Promise<void>
  refresh: () => void
}

export function useMissionControl(enabled: boolean): MissionControlData {
  const [summaries, setSummaries] = useState<MissionControlSummary[]>([])
  const [permissions, setPermissions] = useState<MissionControlPermission[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [responding, setResponding] = useState<Set<string>>(new Set())
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    return () => { cancelledRef.current = true }
  }, [])

  const fetchNow = useCallback(async () => {
    try {
      const res = await authFetch("/api/mission-control")
      if (cancelledRef.current) return
      if (!res.ok) throw new Error(`Mission Control request failed (${res.status})`)
      const data = await res.json() as MissionControlResponse
      if (cancelledRef.current) return
      setSummaries(Array.isArray(data.summaries) ? data.summaries : [])
      setPermissions(Array.isArray(data.permissions) ? data.permissions : [])
      setError(null)
    } catch (err) {
      if (cancelledRef.current) return
      setError(err instanceof Error ? err.message : "Failed to load Mission Control")
    } finally {
      if (!cancelledRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    setLoading(true)

    const pollWhenVisible = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void fetchNow()
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchNow()
    }

    pollWhenVisible()
    const id = setInterval(pollWhenVisible, POLL_INTERVAL)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [enabled, fetchNow])

  const respond = useCallback(async (
    sessionId: string,
    requestId: string,
    behavior: PermissionDecision,
  ) => {
    setResponding((prev) => new Set(prev).add(requestId))
    try {
      if (await respondToPermission(sessionId, requestId, behavior)) {
        // Drop it locally so the card releases immediately rather than waiting
        // out the poll interval.
        setPermissions((prev) => prev.filter((p) => p.requestId !== requestId))
      }
    } catch {
      // The next poll re-surfaces the request if the answer did not land.
    } finally {
      setResponding((prev) => {
        const next = new Set(prev)
        next.delete(requestId)
        return next
      })
      void fetchNow()
    }
  }, [fetchNow])

  const summariesById = useMemo(() => {
    const map = new Map<string, MissionControlSummary>()
    for (const s of summaries) map.set(s.sessionId, s)
    return map
  }, [summaries])

  const permissionsBySession = useMemo(() => {
    const map = new Map<string, MissionControlPermission[]>()
    for (const p of permissions) {
      const list = map.get(p.sessionId)
      if (list) list.push(p)
      else map.set(p.sessionId, [p])
    }
    return map
  }, [permissions])

  const awaitingPermission = useMemo(
    () => new Set(permissionsBySession.keys()),
    [permissionsBySession],
  )

  const refresh = useCallback(() => { void fetchNow() }, [fetchNow])

  return {
    summaries: summariesById,
    permissionsBySession,
    awaitingPermission,
    loading,
    error,
    responding,
    respond,
    refresh,
  }
}
