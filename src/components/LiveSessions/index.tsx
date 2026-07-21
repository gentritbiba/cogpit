import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import { Loader2, RefreshCw, Activity, AlertTriangle, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import { deviceScopedKey, getActiveDeviceId } from "@/lib/device"
import { dirNameToPath } from "@/lib/format"
import { sortSessionsByRecency } from "@/lib/sessionOrdering"
import type { ActiveSessionInfo, RunningProcess } from "./types"
import { usePty } from "@/contexts/PtyContext"
import type { PendingSessionInfo } from "@/components/session-browser/types"
import { useSessionNames } from "@/hooks/useSessionNames"
import { useProjectNames } from "@/hooks/useProjectNames"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { hapticMedium } from "@/lib/haptics"
import { countLiveSessions } from "./liveSessionSummary"
import { groupByProject, projectGroupKey } from "./sessionListView"
import { classifyAttention } from "./attentionGroups"
import { AttentionStrip } from "./AttentionStrip"
import { ProjectGroupList } from "./ProjectGroupList"
import {
  readCachedList,
  sessionListCacheKeys,
  writeCachedList,
} from "@/lib/sessionListCache"

// Re-export extracted modules so external imports remain unchanged
export { SessionRow } from "./SessionRow"
export type { ActiveSessionInfo, RunningProcess } from "./types"

interface LiveSessionsProps {
  activeSessionKey: string | null
  onSelectSession: (dirName: string, fileName: string) => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (dirName: string, fileName: string) => void
  onNewSession?: (dirName: string, cwd?: string) => void
  creatingSession?: boolean
  /** Info about a session being created — shows a placeholder row */
  pendingSession?: PendingSessionInfo | null
  /** Ref to expose an imperative refresh callback */
  refreshRef?: React.MutableRefObject<(() => void) | null>
  /** Warm the session cache for a row on hover-intent so a subsequent click is instant. */
  onPrefetchSession?: (dirName: string, fileName: string) => void
}

/** Map processes to sessions by sessionId (keep highest-mem per session). */
function buildProcMap(processes: RunningProcess[]): Map<string, RunningProcess> {
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

export const LiveSessions = memo(function LiveSessions({ activeSessionKey, onSelectSession, onDuplicateSession, onDeleteSession, onNewSession, creatingSession, pendingSession, refreshRef, onPrefetchSession }: LiveSessionsProps) {
  const { names: sessionNames, rename: renameSession } = useSessionNames()
  const { names: projectNames, rename: renameProject } = useProjectNames()
  const pty = usePty()
  const [mountedDeviceId] = useState(getActiveDeviceId)
  const [initialCachedData] = useState(() => ({
    sessions: readCachedList<ActiveSessionInfo>(sessionListCacheKeys.activeSessions) ?? [],
    processes: readCachedList<RunningProcess>(sessionListCacheKeys.runningProcesses) ?? [],
  }))
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>(initialCachedData.sessions)
  const [processes, setProcesses] = useState<RunningProcess[]>(initialCachedData.processes)
  const [loading, setLoading] = useState(false)
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set())
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  // Per-project collapse choices, persisted so the user's arrangement survives
  // reloads. Groups without an entry fall back to smart defaults (live groups
  // and the most recent few stay open).
  // Device-scoped: DeviceRoot remounts on device change, so computing the key
  // once at mount is sufficient — each device gets its own collapse state.
  const [collapsedGroups, setCollapsedGroups] = useLocalStorage<Record<string, boolean>>(
    deviceScopedKey("live-sessions-collapsed-projects"),
    {},
  )
  const toggleGroupCollapsed = useCallback((key: string, collapsed: boolean) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: collapsed }))
  }, [setCollapsedGroups])
  // Tracks sessions that transitioned to "completed" during this browser session
  const [newlyCompleted, setNewlyCompleted] = useState<Set<string>>(new Set())
  const prevStatusRef = useRef<Map<string, string> | null>(null)
  const sessionsRef = useRef(sessions)
  const abortRef = useRef<AbortController | null>(null)
  const timeoutHandlesRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const mountedRef = useRef(false)

  const scheduleTimeout = useCallback((callback: () => void, delay: number) => {
    if (!mountedRef.current) return
    const handle = setTimeout(() => {
      timeoutHandlesRef.current.delete(handle)
      if (mountedRef.current) callback()
    }, delay)
    timeoutHandlesRef.current.add(handle)
  }, [])

  useEffect(() => {
    const timeoutHandles = timeoutHandlesRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      abortRef.current = null
      for (const handle of timeoutHandles) clearTimeout(handle)
      timeoutHandles.clear()
    }
  }, [])

  // Event handlers read the latest committed inventory. Keeping this write in
  // an effect avoids leaking values from a render that React later discards.
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  const fetchData = useCallback(async () => {
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
      const [sessData, procData] = await Promise.all([
        sessRes.json(),
        procRes.json(),
      ])
      if (!isCurrentRequest()) return
      const nextSessions = Array.isArray(sessData) ? sessData as ActiveSessionInfo[] : []
      const nextProcesses = Array.isArray(procData) ? procData as RunningProcess[] : []
      setSessions(nextSessions)
      setProcesses(nextProcesses)
      writeCachedList(sessionListCacheKeys.activeSessions, nextSessions)
      writeCachedList(sessionListCacheKeys.runningProcesses, nextProcesses)
      setFetchError(null)
    } catch (err) {
      if (!isCurrentRequest()) return
      setFetchError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      if (isCurrentRequest()) setLoading(false)
      if (abortRef.current === ac) abortRef.current = null
    }
  }, [mountedDeviceId])

  // Expose imperative refresh so a parent can force a data fetch (for example,
  // after session finalization). The callback is installed only after commit.
  useEffect(() => {
    if (!refreshRef) return
    refreshRef.current = fetchData
    return () => {
      if (refreshRef.current === fetchData) refreshRef.current = null
    }
  }, [fetchData, refreshRef])

  const isMobile = useIsMobile()

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Session inventory is not polled unconditionally — scanning every project
  // and spawning `ps` on a timer consumed a full CPU core in bursts. Besides
  // lifecycle events and the refresh button, we refresh on window focus, and
  // poll gently ONLY while the attention strip has live work and the tab is
  // visible (see effects below).

  const procBySession = useMemo(
    () => buildProcMap(processes),
    [processes]
  )
  const liveSessionCount = useMemo(
    () => countLiveSessions(sessions, procBySession),
    [sessions, procBySession]
  )

  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return sessions
    return sessions.filter((session) => {
      const customSessionName = sessionNames[session.sessionId]
      const customProjectName = projectNames[session.dirName]
      return [
        customSessionName,
        customProjectName,
        session.aiTitle,
        session.firstUserMessage,
        session.lastUserMessage,
        session.slug,
        session.cwd,
        session.projectShortName,
        session.gitBranch,
        session.agentName,
        session.teamName,
      ].some((value) => value?.toLowerCase().includes(query))
    })
  }, [sessions, searchQuery, sessionNames, projectNames])

  // Group sessions by project path
  const grouped = useMemo(() => groupByProject(filteredSessions), [filteredSessions])

  // Cross-project triage for the attention strip (independent of search)
  const attention = useMemo(
    () => classifyAttention(sessions, procBySession, newlyCompleted),
    [sessions, procBySession, newlyCompleted]
  )
  const hasAttention = attention.needsYou.length > 0 || attention.working.length > 0
  const showAttentionStrip = !searchQuery.trim() && hasAttention

  // Refresh the inventory when the window regains focus — the moment the user
  // comes back to Cogpit is exactly when the strip must be accurate.
  useEffect(() => {
    const onFocus = () => fetchData()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [fetchData])

  // Gentle live polling: only while something is running or waiting, and only
  // while the tab is visible. Idle dashboards cost nothing.
  useEffect(() => {
    if (!hasAttention) return
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchData()
    }, 20_000)
    return () => clearInterval(interval)
  }, [hasAttention, fetchData])

  // Derive pending session's project path once (used for group matching)
  const pendingProjectPath = useMemo(() => {
    if (!pendingSession) return null
    return projectGroupKey(pendingSession.cwd || dirNameToPath(pendingSession.dirName))
  }, [pendingSession])

  // Idle-warm the LRU cache for the top few recent sessions after the sidebar
  // first loads. Subsequent clicks on any of them become cache hits and the
  // load dispatches synchronously. Bounded to a handful — more would just
  // push recently-viewed sessions out of the LRU (MAX_ENTRIES=5).
  const didWarmUpRef = useRef(false)
  useEffect(() => {
    if (didWarmUpRef.current) return
    if (!onPrefetchSession) return
    if (sessions.length === 0) return
    didWarmUpRef.current = true
    // Schedule on idle so the main thread is free during the post-boot render.
    const topThree = sortSessionsByRecency(sessions).slice(0, 3)
    const glob = globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (handle: number) => void
    }
    const run = () => {
      for (const s of topThree) onPrefetchSession(s.dirName, s.fileName)
    }
    let idleHandle: number | null = null
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    if (typeof glob.requestIdleCallback === "function") {
      idleHandle = glob.requestIdleCallback(run, { timeout: 1500 })
    } else {
      timeoutHandle = setTimeout(run, 300)
    }
    // Cancel the pending callback if the sidebar unmounts before it fires.
    return () => {
      if (idleHandle != null && typeof glob.cancelIdleCallback === "function") {
        glob.cancelIdleCallback(idleHandle)
      }
      if (timeoutHandle != null) clearTimeout(timeoutHandle)
    }
  }, [sessions, onPrefetchSession])

  // Detect status transitions to "completed" — only highlight newly completed sessions.
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

  const handleKill = useCallback(async (pid: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setKillingPids(prev => new Set(prev).add(pid))
    try {
      await authFetch("/api/kill-process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid }),
      })
      scheduleTimeout(fetchData, 1500)
    } catch { /* ignore */ }
    scheduleTimeout(() => {
      setKillingPids(prev => {
        const next = new Set(prev)
        next.delete(pid)
        return next
      })
    }, 2000)
  }, [fetchData, scheduleTimeout])

  const handleSelectSession = useCallback((dirName: string, fileName: string) => {
    const match = sessionsRef.current.find((s) => s.dirName === dirName && s.fileName === fileName)
    if (match) {
      setNewlyCompleted((prev) => {
        if (!prev.has(match.sessionId)) return prev
        const next = new Set(prev)
        next.delete(match.sessionId)
        return next
      })
    }
    onSelectSession(dirName, fileName)
  }, [onSelectSession])

  const handleDeleteSession = useCallback((s: ActiveSessionInfo) => {
    onDeleteSession?.(s.dirName, s.fileName)
    const next = sessionsRef.current.filter((x) => x.sessionId !== s.sessionId)
    sessionsRef.current = next
    setSessions(next)
    if (getActiveDeviceId() === mountedDeviceId) {
      writeCachedList(sessionListCacheKeys.activeSessions, next)
    }
  }, [mountedDeviceId, onDeleteSession])

  /**
   * Spawn `claude -p --resume <sessionId>` in a PTY terminal so the user can
   * re-evaluate a permission that was paused by a PreToolUse hook decision:"defer".
   */
  const handleResumeSession = useCallback((sessionId: string, cwd?: string) => {
    const id = `resume_${crypto.randomUUID().slice(0, 8)}`
    pty.send({
      type: "spawn",
      id,
      name: `Resume ${sessionId.slice(0, 8)}`,
      command: "claude",
      args: ["-p", "--resume", sessionId],
      cwd: cwd ?? undefined,
      metadata: { type: "terminal" },
    })
    // Refresh sessions after a brief delay to pick up any status change
    scheduleTimeout(fetchData, 3000)
  }, [pty, fetchData, scheduleTimeout])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Provider-neutral session search + truthful live summary */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search live & recent…"
            aria-label="Search live and recent sessions by project, branch, title, first prompt, or latest prompt"
            className="w-full rounded-md border border-border/60 py-1.5 pl-7 pr-7 text-[13px] text-foreground placeholder:text-muted-foreground focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear session search"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {liveSessionCount > 0 && (
            <span className="text-[11px] text-muted-foreground whitespace-nowrap" aria-label={`${liveSessionCount} live sessions`}>
              {liveSessionCount} live
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={cn("p-0 shrink-0", isMobile ? "h-8 w-8" : "h-6 w-6")}
            onClick={() => { hapticMedium(); fetchData() }}
            aria-label="Refresh sessions"
          >
            <RefreshCw
              className={cn(isMobile ? "size-4" : "size-3", loading && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 px-1.5 pt-0.5 pb-3">
          {fetchError && (
            <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-red-900/50 bg-red-950/30 px-2 py-1.5">
              <AlertTriangle className="size-3 text-red-400 shrink-0" />
              <span className="text-[10px] text-red-400 flex-1 truncate">{fetchError}</span>
              <button
                type="button"
                onClick={() => { setFetchError(null); fetchData() }}
                className="text-[10px] text-red-400 hover:text-red-300 shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {filteredSessions.length === 0 && !pendingSession && !loading && !fetchError && (
            <div className="px-3 py-8 text-center">
              {searchQuery.trim() ? (
                <>
                  <Search className="size-5 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-[13px] text-muted-foreground">No matching sessions</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Try a project, branch, title, first prompt, or latest prompt</p>
                </>
              ) : (
                <>
                  <Activity className="size-5 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-[13px] text-muted-foreground">No sessions yet</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Start Claude Code or Codex to see live and recent work here</p>
                </>
              )}
            </div>
          )}

          {loading && sessions.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Attention strip — cross-project triage: who needs me, who's working */}
          {showAttentionStrip && (
            <div className="flex flex-col gap-2 pt-1.5">
              <AttentionStrip
                groups={attention}
                activeSessionKey={activeSessionKey}
                procBySession={procBySession}
                killingPids={killingPids}
                sessionNames={sessionNames}
                projectNames={projectNames}
                onSelectSession={handleSelectSession}
                onKill={handleKill}
                onResumeSession={handleResumeSession}
                onPrefetchSession={onPrefetchSession}
              />
              <div className="flex items-center gap-1.5 px-0.5 pt-1">
                <span className="text-[10px] font-semibold tracking-wider text-muted-foreground/50">
                  PROJECTS
                </span>
                <div className="h-px flex-1 bg-border/40" />
              </div>
            </div>
          )}

          <ProjectGroupList
            grouped={grouped}
            pendingProjectPath={pendingProjectPath}
            pendingSession={pendingSession}
            collapsedGroups={collapsedGroups}
            searchQuery={searchQuery}
            activeSessionKey={activeSessionKey}
            procBySession={procBySession}
            killingPids={killingPids}
            newlyCompleted={newlyCompleted}
            sessionNames={sessionNames}
            projectNames={projectNames}
            onToggleCollapsed={toggleGroupCollapsed}
            onSelectSession={handleSelectSession}
            onKill={handleKill}
            onDuplicateSession={onDuplicateSession}
            onDeleteSession={onDeleteSession ? handleDeleteSession : undefined}
            onRenameSession={renameSession}
            onRenameProject={renameProject}
            onNewSession={onNewSession}
            creatingSession={creatingSession}
            onPrefetchSession={onPrefetchSession}
            onResumeSession={handleResumeSession}
          />

        </div>
      </ScrollArea>
    </div>
  )
})
