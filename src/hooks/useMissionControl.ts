/**
 * Per-session card summaries for Mission Control.
 *
 * One poll covers every card. Pending permissions come from
 * PendingHumanInputContext instead, because the sidebar and header need them
 * whether or not this view is open.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"
import { listUrl, useSessionListFilter } from "@/lib/sessionListFilter"
import type {
  MissionControlResponse,
  MissionControlSummary,
} from "../../shared/contracts/missionControl"

/**
 * Summaries re-read session files, so this is gentler than the permission poll
 * and idles entirely while the tab is hidden.
 */
const POLL_INTERVAL = 4_000

export interface MissionControlData {
  summaries: Map<string, MissionControlSummary>
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useMissionControl(): MissionControlData {
  const filter = useSessionListFilter()
  const [summaries, setSummaries] = useState<MissionControlSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  // A poll for a filter just left never lands after it; overlapping polls for this one all do.
  const filterKeyRef = useRef(filter.key)

  useEffect(() => {
    cancelledRef.current = false
    return () => { cancelledRef.current = true }
  }, [])

  useLayoutEffect(() => { filterKeyRef.current = filter.key }, [filter.key])

  const fetchNow = useCallback(async () => {
    const stale = () => cancelledRef.current || filterKeyRef.current !== filter.key
    try {
      const res = await authFetch(listUrl("/api/mission-control", filter))
      if (stale()) return
      if (!res.ok) throw new Error(`Mission Control request failed (${res.status})`)
      const data = await res.json() as MissionControlResponse
      if (stale()) return
      setSummaries(Array.isArray(data.summaries) ? data.summaries : [])
      setError(null)
    } catch (err) {
      if (stale()) return
      setError(err instanceof Error ? err.message : "Failed to load Mission Control")
    } finally {
      if (!stale()) setLoading(false)
    }
  }, [filter])

  useEffect(() => {
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
  }, [fetchNow])

  const summariesById = useMemo(() => {
    const map = new Map<string, MissionControlSummary>()
    for (const s of summaries) map.set(s.sessionId, s)
    return map
  }, [summaries])

  const refresh = useCallback(() => { void fetchNow() }, [fetchNow])

  return { summaries: summariesById, loading, error, refresh }
}
