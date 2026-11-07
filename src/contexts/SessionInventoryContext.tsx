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
import { useAppGate } from "@/hooks/useCurrentUser"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { hasUnfinishedWork } from "@/lib/sessionActivity"
import type { ActiveSessionInfo, RunningProcess } from "@/components/LiveSessions/types"
import {
  activeSessionsCacheKey,
  readCachedList,
  sessionListCacheKeys,
  writeCachedLists,
} from "@/lib/sessionListCache"
import { activeSessionsUrl, useSessionListFilter } from "@/lib/sessionListFilter"
import { learnListedAccess, onListsStale, sessionAccessTicket } from "@/lib/sessionAccess"
import { subscribeSessionListEvents } from "@/lib/sessionListEvents"
import { shareList } from "@/lib/structuralShare"
import { SESSION_LIST_VERSION_HEADER } from "../../shared/contracts/sessionList"

const LIVE_POLL_INTERVAL = 20_000
const FALLBACK_POLL_INTERVAL = 60_000
const FOCUS_MIN_INTERVAL = 5_000

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
  /** The list for the current filter is being read for the first time; background refreshes leave it false. */
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

const sessionKeyOf = (session: ActiveSessionInfo) => `${session.dirName}/${session.fileName}`
const processKeyOf = (process: RunningProcess) => String(process.pid)

function listVersion(response: Response): number | null {
  const version = Number(response.headers.get(SESSION_LIST_VERSION_HEADER))
  return response.headers.has(SESSION_LIST_VERSION_HEADER) && Number.isFinite(version) ? version : null
}

/**
 * What a list fetch also does: `full` reads the running processes beside the
 * list; `list` reads them only when the list changed; `rows` only adds rows
 * (archived ones), which no process drives.
 */
type FetchMode = "full" | "list" | "rows"

export function SessionInventoryProvider({ children }: { children: ReactNode }) {
  const [mountedDeviceScope] = useState(getActiveDeviceScope)
  const filter = useSessionListFilter()
  // The server refuses the list while its gate shows; it is read again once the gate lifts.
  const gated = useAppGate() !== null
  const [showArchivedSetting, setShowArchivedSetting] = useLocalStorage<boolean>(
    deviceScopedKey("live-sessions-show-archived"),
    false,
  )
  const showArchived = showArchivedSetting === true
  const [searchActive, setSearchActive] = useState(false)
  const wantArchived = showArchived || searchActive
  const [initialCacheKey] = useState(() => activeSessionsCacheKey(filter.key, showArchived))
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>(
    () => readCachedList<ActiveSessionInfo>(initialCacheKey) ?? [],
  )
  const [processes, setProcesses] = useState<RunningProcess[]>(
    () => readCachedList<RunningProcess>(sessionListCacheKeys.runningProcesses) ?? [],
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newlyCompleted, setNewlyCompleted] = useState<Set<string>>(new Set())
  const [archivedCount, setArchivedCount] = useState(0)
  const [pushUnsupported, setPushUnsupported] = useState(false)
  // Seeded from the cached list so a session archived before a reload still
  // reads as archived. Read by setArchived for the same reason as sessionsRef.
  const archivedIdsRef = useRef<ReadonlySet<string>>(learnArchivedIds(new Set(), sessions))
  const [archivedIds, setArchivedIds] = useState<ReadonlySet<string>>(archivedIdsRef.current)
  const replaceArchivedIds = useCallback((next: ReadonlySet<string>) => {
    if (next === archivedIdsRef.current) return
    archivedIdsRef.current = next
    setArchivedIds(next)
  }, [])

  const prevStatusRef = useRef<Map<string, string> | null>(null)
  // Set when the list's membership changes for a reason other than activity
  // (a filter switch, lists going stale): the next fetched list becomes
  // the baseline, so what it brings in is not reported as just finished.
  const awaitingBaselineRef = useRef(false)
  // Read by setArchived so back-to-back updates (an optimistic change and its
  // rollback) each see the other's result instead of a stale render.
  const sessionsRef = useRef(sessions)
  // The cache entry the rows in hand belong to, whether they include archived
  // sessions, and the validator of the response they came from.
  const rowsKeyRef = useRef(initialCacheKey)
  const rowsIncludeArchivedRef = useRef(showArchived)
  const validatorRef = useRef<{ url: string; etag: string } | null>(null)
  const loadedKeyRef = useRef<string | null>(null)
  const writtenRef = useRef({ key: initialCacheKey, sessions, processes })
  const filterRef = useRef(filter)
  const wantArchivedRef = useRef(wantArchived)
  // List versions: the newest the server announced, and the one the rows show.
  const announcedVersionRef = useRef(0)
  const heldVersionRef = useRef(0)
  const staleRef = useRef(false)
  const lastListFetchRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const processAbortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    filterRef.current = filter
    wantArchivedRef.current = wantArchived
  }, [filter, wantArchived])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
      processAbortRef.current?.abort()
      processAbortRef.current = null
    }
  }, [])

  const replaceSessions = useCallback((next: ActiveSessionInfo[], key: string) => {
    rowsKeyRef.current = key
    if (next === sessionsRef.current) return
    sessionsRef.current = next
    setSessions(next)
  }, [])

  const canFetch = useCallback(() => (
    !gated && mountedRef.current && getActiveDeviceScope() === mountedDeviceScope
  ), [gated, mountedDeviceScope])

  const loadProcesses = useCallback(async () => {
    if (!canFetch()) return
    processAbortRef.current?.abort()
    const ac = new AbortController()
    processAbortRef.current = ac
    try {
      // Unfiltered: the open session may be outside the list, and whether
      // another process drives it is read from here.
      const response = await authFetch("/api/running-processes", { signal: ac.signal })
      if (!response.ok) return
      const data: unknown = await response.json()
      if (ac.signal.aborted || !mountedRef.current) return
      const next = Array.isArray(data) ? data as RunningProcess[] : []
      setProcesses((previous) => shareList(previous, next, processKeyOf))
    } catch {
      // The list still shows; the next refresh asks again.
    } finally {
      if (processAbortRef.current === ac) processAbortRef.current = null
    }
  }, [canFetch])

  const fetchInventory = useCallback(async (mode: FetchMode) => {
    if (!canFetch()) return
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const isCurrentRequest = () => (
      mountedRef.current
      && !ac.signal.aborted
      && abortRef.current === ac
      && getActiveDeviceScope() === mountedDeviceScope
    )

    const includeArchived = wantArchivedRef.current
    const url = activeSessionsUrl(includeArchived ? { archived: "include" } : {}, filterRef.current)
    const cacheKey = activeSessionsCacheKey(filterRef.current.key, includeArchived)
    const validator = validatorRef.current
    const headers = validator?.url === url && rowsKeyRef.current === cacheKey
      ? { "If-None-Match": validator.etag }
      : undefined
    const versionAtStart = announcedVersionRef.current
    if (loadedKeyRef.current !== cacheKey) setLoading(true)
    lastListFetchRef.current = Date.now()
    staleRef.current = false
    const accessTicket = sessionAccessTicket()
    try {
      const request = authFetch(url, { signal: ac.signal, ...(headers && { headers }) })
      if (mode === "full") void loadProcesses()
      const response = await request
      if (!isCurrentRequest()) return
      let changed = false
      if (response.status !== 304) {
        if (!response.ok) throw new Error("Failed to fetch live data")
        const data: unknown = await response.json()
        if (!isCurrentRequest()) return
        const fetched = Array.isArray(data) ? data as ActiveSessionInfo[] : []
        learnListedAccess(fetched, accessTicket)
        if (awaitingBaselineRef.current) {
          awaitingBaselineRef.current = false
          prevStatusRef.current = null
        }
        const shared = shareList(sessionsRef.current, fetched, sessionKeyOf)
        changed = shared !== sessionsRef.current
        replaceSessions(shared, cacheKey)
        rowsIncludeArchivedRef.current = includeArchived
        replaceArchivedIds(learnArchivedIds(archivedIdsRef.current, shared))
        setArchivedCount(Number(response.headers.get("X-Cogpit-Archived-Count")) || 0)
        const etag = response.headers.get("ETag")
        validatorRef.current = etag ? { url, etag } : null
      }
      loadedKeyRef.current = cacheKey
      heldVersionRef.current = Math.max(heldVersionRef.current, listVersion(response) ?? versionAtStart)
      setError(null)
      if (mode === "list" && changed) void loadProcesses()
      abortRef.current = null
      // Something changed while this request ran: read the list once more.
      if (announcedVersionRef.current > heldVersionRef.current && document.visibilityState === "visible") {
        void fetchInventory("list")
      }
    } catch (err) {
      if (!isCurrentRequest()) return
      setError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      if (abortRef.current === ac) abortRef.current = null
      if (abortRef.current === null && mountedRef.current) setLoading(false)
    }
  }, [canFetch, mountedDeviceScope, loadProcesses, replaceSessions, replaceArchivedIds])

  const fetchRef = useRef(fetchInventory)
  useEffect(() => {
    fetchRef.current = fetchInventory
  }, [fetchInventory])
  const refresh = useCallback(() => { void fetchInventory("full") }, [fetchInventory])

  // A new filter shows its own cached list while the refresh for it runs.
  useEffect(() => {
    const key = activeSessionsCacheKey(filter.key, wantArchivedRef.current)
    if (rowsKeyRef.current === key) return
    awaitingBaselineRef.current = true
    const cached = readCachedList<ActiveSessionInfo>(key) ?? []
    rowsIncludeArchivedRef.current = wantArchivedRef.current
    writtenRef.current = { ...writtenRef.current, key, sessions: cached }
    replaceSessions(cached, key)
  }, [filter.key, replaceSessions])

  useEffect(() => {
    refresh()
  }, [refresh, filter])

  // A search or the archive toggle needs archived rows; ending either keeps the
  // rows in hand (lists hide archived ones) until the next refresh.
  useEffect(() => {
    if (wantArchived && !rowsIncludeArchivedRef.current) void fetchRef.current("rows")
  }, [wantArchived])

  // Which sessions the lists hold moved; list them again.
  useEffect(() => onListsStale(() => {
    awaitingBaselineRef.current = true
    refresh()
  }), [refresh])

  // The server announces each list change; a hidden window reads it once it shows again.
  useEffect(() => {
    if (gated) return
    return subscribeSessionListEvents({
      onVersion: (version) => {
        announcedVersionRef.current = Math.max(announcedVersionRef.current, version)
        if (version <= heldVersionRef.current || abortRef.current) return
        if (document.visibilityState === "visible") void fetchRef.current("list")
        else staleRef.current = true
      },
      onUnsupported: () => setPushUnsupported(true),
    })
  }, [gated])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && staleRef.current) void fetchRef.current("list")
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])

  const procBySession = useMemo(() => buildProcMap(processes), [processes])

  // Spawning `ps` on a timer once consumed a full CPU core in bursts, so the
  // processes refresh on a gentle visible-only timer only while something is live.
  const hasLiveWork = useMemo(
    () => hasUnfinishedWork(sessions, procBySession),
    [sessions, procBySession],
  )

  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastListFetchRef.current >= FOCUS_MIN_INTERVAL) refresh()
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [refresh])

  // Without the stream (an older server) the list is read on a visible-only
  // timer: every 20 s while something is live, every 60 s otherwise. With the
  // stream, the live timer only follows the processes.
  useEffect(() => {
    if (!hasLiveWork && !pushUnsupported) return
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") {
        if (pushUnsupported) staleRef.current = true
        return
      }
      if (!pushUnsupported) void loadProcesses()
      else void fetchRef.current(hasLiveWork ? "full" : "list")
    }, hasLiveWork ? LIVE_POLL_INTERVAL : FALLBACK_POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [hasLiveWork, pushUnsupported, loadProcesses])

  // The cache follows the lists once they changed, in one write after paint.
  // Archived rows a search brought in are not kept: a cold start reads them
  // only while the archive toggle is on.
  useEffect(() => {
    if (getActiveDeviceScope() !== mountedDeviceScope) return
    const written = writtenRef.current
    const key = rowsKeyRef.current
    const keepsRows = !rowsIncludeArchivedRef.current || showArchived
    const writes: Array<readonly [string, unknown[]]> = []
    if (keepsRows && (written.sessions !== sessions || written.key !== key)) writes.push([key, sessions])
    if (written.processes !== processes) writes.push([sessionListCacheKeys.runningProcesses, processes])
    if (writes.length === 0) return
    writtenRef.current = keepsRows ? { key, sessions, processes } : { ...written, processes }
    writeCachedLists(writes)
  }, [sessions, processes, mountedDeviceScope, showArchived])

  // Highlight a session seen working that just finished, until the user looks
  // at it. One the list brings in already finished was never seen working.
  useEffect(() => {
    if (sessions.length === 0 || awaitingBaselineRef.current) return

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
          if (status === "completed" && prev.has(id) && prev.get(id) !== "completed") {
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
    replaceSessions(sessionsRef.current.filter((s) => s.sessionId !== sessionId), rowsKeyRef.current)
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
    }), rowsKeyRef.current)
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
