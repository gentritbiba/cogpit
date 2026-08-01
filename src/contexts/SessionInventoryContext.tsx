/**
 * The session inventory — `/api/active-sessions` + `/api/running-processes` —
 * owned in one place.
 *
 * This logic used to live privately inside `LiveSessions`. Mission Control needs
 * exactly the same data, and two independent copies would mean two polls, two
 * caches, and two chances to disagree about which sessions are live. The
 * provider is mounted per device root, so switching devices remounts it and each
 * device keeps its own inventory.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { authFetch } from "@/lib/auth"
import { getActiveDeviceId } from "@/lib/device"
import type { ActiveSessionInfo, RunningProcess } from "@/components/LiveSessions/types"
import {
  readCachedList,
  sessionListCacheKeys,
  writeCachedList,
} from "@/lib/sessionListCache"

/** Map processes to sessions by sessionId (keep highest-mem per session). */
export function buildProcMap(processes: RunningProcess[]): Map<string, RunningProcess> {
  const map = new Map<string, RunningProcess>()
  for (const p of processes) {
    if (!p.sessionId) continue
    const existing = map.get(p.sessionId)
    if (!existing || p.memMB > existing.memMB) {
      map.set(p.sessionId, p)
    }
  }
  return map
}

export interface SessionInventory {
  sessions: ActiveSessionInfo[]
  processes: RunningProcess[]
  procBySession: Map<string, RunningProcess>
  /** Sessions that transitioned to "completed" during this browser session. */
  newlyCompleted: Set<string>
  loading: boolean
  error: string | null
  refresh: () => void
  /** Forget a session locally after it is deleted, without a round trip. */
  removeSession: (sessionId: string) => void
  /** Clear a session's "just finished" highlight once the user has seen it. */
  acknowledgeCompleted: (sessionId: string) => void
}

const SessionInventoryContext = createContext<SessionInventory | null>(null)

export function SessionInventoryProvider({ children }: { children: ReactNode }) {
  const [mountedDeviceId] = useState(getActiveDeviceId)
  const [initialCachedData] = useState(() => ({
    sessions: readCachedList<ActiveSessionInfo>(sessionListCacheKeys.activeSessions) ?? [],
    processes: readCachedList<RunningProcess>(sessionListCacheKeys.runningProcesses) ?? [],
  }))
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>(initialCachedData.sessions)
  const [processes, setProcesses] = useState<RunningProcess[]>(initialCachedData.processes)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newlyCompleted, setNewlyCompleted] = useState<Set<string>>(new Set())

  const prevStatusRef = useRef<Map<string, string> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!mountedRef.current || getActiveDeviceId() !== mountedDeviceId) return
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const isCurrentRequest = () => (
      mountedRef.current
      && !ac.signal.aborted
      && abortRef.current === ac
      && getActiveDeviceId() === mountedDeviceId
    )

    setLoading(true)
    try {
      const [sessRes, procRes] = await Promise.all([
        authFetch("/api/active-sessions", { signal: ac.signal }),
        authFetch("/api/running-processes", { signal: ac.signal }),
      ])
      if (!isCurrentRequest()) return
      if (!sessRes.ok || !procRes.ok) {
        throw new Error("Failed to fetch live data")
      }
      const [sessData, procData] = await Promise.all([sessRes.json(), procRes.json()])
      if (!isCurrentRequest()) return
      const nextSessions = Array.isArray(sessData) ? sessData as ActiveSessionInfo[] : []
      const nextProcesses = Array.isArray(procData) ? procData as RunningProcess[] : []
      setSessions(nextSessions)
      setProcesses(nextProcesses)
      writeCachedList(sessionListCacheKeys.activeSessions, nextSessions)
      writeCachedList(sessionListCacheKeys.runningProcesses, nextProcesses)
      setError(null)
    } catch (err) {
      if (!isCurrentRequest()) return
      setError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      if (isCurrentRequest()) setLoading(false)
      if (abortRef.current === ac) abortRef.current = null
    }
  }, [mountedDeviceId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const procBySession = useMemo(() => buildProcMap(processes), [processes])

  // Scanning every project and spawning `ps` on a timer once consumed a full
  // CPU core in bursts, so the inventory is not polled unconditionally: it
  // refreshes on focus and, while something is live, on a gentle visible-only
  // timer.
  const hasLiveWork = useMemo(
    () => sessions.some((s) => s.isActive || procBySession.has(s.sessionId)),
    [sessions, procBySession],
  )

  useEffect(() => {
    const onFocus = () => refresh()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [refresh])

  useEffect(() => {
    if (!hasLiveWork) return
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh()
    }, 20_000)
    return () => clearInterval(interval)
  }, [hasLiveWork, refresh])

  // Detect transitions to "completed" so a session that just finished can be
  // highlighted until the user looks at it.
  useEffect(() => {
    if (sessions.length === 0) return

    const prev = prevStatusRef.current
    const currentStatuses = new Map<string, string>()
    for (const s of sessions) {
      if (s.agentStatus && procBySession.has(s.sessionId)) {
        currentStatuses.set(s.sessionId, s.agentStatus)
      }
    }

    if (prev !== null) {
      setNewlyCompleted((nc) => {
        let next: Set<string> | null = null
        for (const [id, status] of currentStatuses) {
          if (status === "completed" && prev.get(id) !== "completed") {
            next ??= new Set(nc)
            next.add(id)
          }
        }
        for (const id of nc) {
          if (currentStatuses.get(id) !== "completed") {
            next ??= new Set(nc)
            next.delete(id)
          }
        }
        return next ?? nc
      })
    }

    prevStatusRef.current = currentStatuses
  }, [sessions, procBySession])

  const acknowledgeCompleted = useCallback((sessionId: string) => {
    setNewlyCompleted((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  const removeSession = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.sessionId !== sessionId)
      if (getActiveDeviceId() === mountedDeviceId) {
        writeCachedList(sessionListCacheKeys.activeSessions, next)
      }
      return next
    })
  }, [mountedDeviceId])

  const refreshNow = useCallback(() => { void refresh() }, [refresh])

  const value = useMemo<SessionInventory>(() => ({
    sessions,
    processes,
    procBySession,
    newlyCompleted,
    loading,
    error,
    refresh: refreshNow,
    removeSession,
    acknowledgeCompleted,
  }), [
    sessions, processes, procBySession, newlyCompleted, loading, error,
    refreshNow, removeSession, acknowledgeCompleted,
  ])

  return (
    <SessionInventoryContext.Provider value={value}>
      {children}
    </SessionInventoryContext.Provider>
  )
}

export function useSessionInventory(): SessionInventory {
  const ctx = useContext(SessionInventoryContext)
  if (!ctx) {
    throw new Error("useSessionInventory must be used within a SessionInventoryProvider")
  }
  return ctx
}
