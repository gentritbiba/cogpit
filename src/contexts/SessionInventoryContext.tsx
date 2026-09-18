/**
 * The session inventory — `/api/active-sessions` + `/api/running-processes` —
 * owned in one place.
 *
 * Lifted out of `LiveSessions` once Mission Control needed the same data: two
 * copies would mean two polls, two caches and two chances to disagree about
 * which sessions are live. Mounted per device root, so each device keeps its own
 * inventory and switching devices remounts it.
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
import { deviceScopedKey, getActiveDeviceScope } from "@/lib/device"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { hasUnfinishedWork } from "@/lib/sessionActivity"
import type { ActiveSessionInfo, RunningProcess } from "@/components/LiveSessions/types"
import {
  readCachedList,
  sessionListCacheKeys,
  writeCachedList,
} from "@/lib/sessionListCache"

const LIVE_POLL_INTERVAL = 20_000

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

/**
 * Fold a fetched list into what is known to be archived. A listed row settles
 * its own id either way; ids the list does not mention keep their last state,
 * since the default list simply leaves archived sessions out.
 */
export function learnArchivedIds(
  known: ReadonlySet<string>,
  listed: readonly ActiveSessionInfo[],
): ReadonlySet<string> {
  let next: Set<string> | null = null
  for (const row of listed) {
    const archived = Boolean(row.archived)
    if (known.has(row.sessionId) === archived) continue
    next ??= new Set(known)
    if (archived) next.add(row.sessionId)
    else next.delete(row.sessionId)
  }
  return next ?? known
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
  /** The user's persisted choice to list archived sessions alongside the rest. */
  showArchived: boolean
  setShowArchived: (show: boolean) => void
  /** A search looks through archived sessions too, so it asks for them while it runs. */
  setSearchActive: (active: boolean) => void
  /** Sessions the user has archived, whether or not they are currently listed. */
  archivedCount: number
  /**
   * Whether a session is archived, as far as this client has seen. The default
   * list omits archived rows, so this outlives the row: a session archived from
   * its own chat still reads as archived after the next refresh drops it.
   */
  isArchived: (sessionId: string) => boolean
  /** Reflect an archive change locally before (or without) the next fetch. */
  setArchived: (sessionIds: readonly string[], archived: boolean) => void
}

const SessionInventoryContext = createContext<SessionInventory | null>(null)

export function SessionInventoryProvider({ children }: { children: ReactNode }) {
  const [mountedDeviceScope] = useState(getActiveDeviceScope)
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>(
    () => readCachedList<ActiveSessionInfo>(sessionListCacheKeys.activeSessions) ?? [],
  )
  const [processes, setProcesses] = useState<RunningProcess[]>(
    () => readCachedList<RunningProcess>(sessionListCacheKeys.runningProcesses) ?? [],
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newlyCompleted, setNewlyCompleted] = useState<Set<string>>(new Set())
  const [showArchivedSetting, setShowArchivedSetting] = useLocalStorage<boolean>(
    deviceScopedKey("live-sessions-show-archived"),
    false,
  )
  const showArchived = showArchivedSetting === true
  const [searchActive, setSearchActive] = useState(false)
  const includeArchived = showArchived || searchActive
  const [archivedCount, setArchivedCount] = useState(0)
  // Seeded from the cached list so a session archived before a reload still
  // reads as archived. Read by setArchived for the same reason as sessionsRef.
  const archivedIdsRef = useRef<ReadonlySet<string>>(learnArchivedIds(new Set(), sessions))
  const [archivedIds, setArchivedIds] = useState<ReadonlySet<string>>(archivedIdsRef.current)
  const replaceArchivedIds = useCallback((next: ReadonlySet<string>) => {
    archivedIdsRef.current = next
    setArchivedIds(next)
  }, [])

  const prevStatusRef = useRef<Map<string, string> | null>(null)
  // Read by setArchived so back-to-back updates (an optimistic change and its
  // rollback) each see the other's result instead of a stale render.
  const sessionsRef = useRef(sessions)
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

  const fetchInventory = useCallback(async () => {
    if (!mountedRef.current || getActiveDeviceScope() !== mountedDeviceScope) return
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const isCurrentRequest = () => (
      mountedRef.current
      && !ac.signal.aborted
      && abortRef.current === ac
      && getActiveDeviceScope() === mountedDeviceScope
    )

    setLoading(true)
    try {
      const [sessRes, procRes] = await Promise.all([
        authFetch(includeArchived ? "/api/active-sessions?archived=include" : "/api/active-sessions", { signal: ac.signal }),
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
      sessionsRef.current = nextSessions
      setSessions(nextSessions)
      setProcesses(nextProcesses)
      replaceArchivedIds(learnArchivedIds(archivedIdsRef.current, nextSessions))
      setArchivedCount(Number(sessRes.headers.get("X-Cogpit-Archived-Count")) || 0)
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
  }, [mountedDeviceScope, includeArchived, replaceArchivedIds])

  const refresh = useCallback(() => { void fetchInventory() }, [fetchInventory])

  useEffect(() => {
    refresh()
  }, [refresh])

  const procBySession = useMemo(() => buildProcMap(processes), [processes])

  // Scanning every project and spawning `ps` on a timer once consumed a full
  // CPU core in bursts, so the inventory refreshes on focus and, while
  // something is live, on a gentle visible-only timer — never unconditionally.
  const hasLiveWork = useMemo(
    () => hasUnfinishedWork(sessions, procBySession),
    [sessions, procBySession],
  )

  useEffect(() => {
    window.addEventListener("focus", refresh)
    return () => window.removeEventListener("focus", refresh)
  }, [refresh])

  useEffect(() => {
    if (!hasLiveWork) return
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refresh()
    }, LIVE_POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [hasLiveWork, refresh])

  // Highlight a session that just finished until the user looks at it.
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

  const replaceSessions = useCallback((next: ActiveSessionInfo[]) => {
    sessionsRef.current = next
    setSessions(next)
    if (getActiveDeviceScope() === mountedDeviceScope) {
      writeCachedList(sessionListCacheKeys.activeSessions, next)
    }
  }, [mountedDeviceScope])

  const removeSession = useCallback((sessionId: string) => {
    replaceSessions(sessionsRef.current.filter((s) => s.sessionId !== sessionId))
  }, [replaceSessions])

  const setArchived = useCallback((sessionIds: readonly string[], archived: boolean) => {
    const known = archivedIdsRef.current
    const changedIds = new Set(sessionIds.filter((id) => known.has(id) !== archived))
    if (changedIds.size === 0) return
    const nextKnown = new Set(known)
    for (const id of changedIds) {
      if (archived) nextKnown.add(id)
      else nextKnown.delete(id)
    }
    replaceArchivedIds(nextKnown)
    replaceSessions(sessionsRef.current.map((s) => {
      if (!changedIds.has(s.sessionId)) return s
      if (archived) return { ...s, archived: true, archivedReason: "manual" as const }
      const { archived: _archived, archivedReason: _archivedReason, ...rest } = s
      return rest
    }))
    const delta = archived ? changedIds.size : -changedIds.size
    setArchivedCount((count) => Math.max(0, count + delta))
  }, [replaceArchivedIds, replaceSessions])

  const isArchived = useCallback((sessionId: string) => archivedIds.has(sessionId), [archivedIds])

  const value = useMemo<SessionInventory>(() => ({
    sessions,
    processes,
    procBySession,
    newlyCompleted,
    loading,
    error,
    refresh,
    removeSession,
    acknowledgeCompleted,
    showArchived,
    setShowArchived: setShowArchivedSetting,
    setSearchActive,
    archivedCount,
    isArchived,
    setArchived,
  }), [
    sessions, processes, procBySession, newlyCompleted, loading, error,
    refresh, removeSession, acknowledgeCompleted,
    showArchived, setShowArchivedSetting, archivedCount, isArchived, setArchived,
  ])

  return (
    <SessionInventoryContext.Provider value={value}>
      {children}
    </SessionInventoryContext.Provider>
  )
}

export function useSessionInventory(): SessionInventory {
  const ctx = useSessionInventoryOptional()
  if (!ctx) {
    throw new Error("useSessionInventory must be used within a SessionInventoryProvider")
  }
  return ctx
}

/**
 * The inventory when one is mounted, otherwise null — for components that can
 * enrich themselves with session-list data but must still render without it.
 */
export function useSessionInventoryOptional(): SessionInventory | null {
  return useContext(SessionInventoryContext)
}
