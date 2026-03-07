import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import { Loader2, RefreshCw, Activity, X, Search, AlertTriangle, FolderOpen, ChevronRight, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { authFetch } from "@/lib/auth"
import { shortPath, dirNameToPath } from "@/lib/format"
import { SessionRow } from "./SessionRow"
import type { ActiveSessionInfo, RunningProcess } from "./SessionRow"
import type { PendingSessionInfo } from "@/components/session-browser/types"
import { useSessionNames } from "@/hooks/useSessionNames"

// Re-export extracted modules so external imports remain unchanged
export { SessionRow } from "./SessionRow"
export type { ActiveSessionInfo, RunningProcess } from "./SessionRow"

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

/** Group sessions by project path for compact display, sorted newest-first. */
function groupByProject(sessions: ActiveSessionInfo[]): Map<string, ActiveSessionInfo[]> {
  const sorted = [...sessions].sort(
    (a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime()
  )
  const groups = new Map<string, ActiveSessionInfo[]>()
  for (const s of sorted) {
    const key = shortPath(s.cwd ?? dirNameToPath(s.dirName), 2)
    const list = groups.get(key)
    if (list) list.push(s)
    else groups.set(key, [s])
  }
  return groups
}

export const LiveSessions = memo(function LiveSessions({ activeSessionKey, onSelectSession, onDuplicateSession, onDeleteSession, onNewSession, creatingSession, pendingSession, refreshRef }: LiveSessionsProps) {
  const { names: sessionNames, rename: renameSession } = useSessionNames()
  const [sessions, setSessions] = useState<ActiveSessionInfo[]>([])
  const [processes, setProcesses] = useState<RunningProcess[]>([])
  const [loading, setLoading] = useState(false)
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set())
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [searching, setSearching] = useState(false)
  // Tracks sessions that transitioned to "completed" during this browser session
  const [newlyCompleted, setNewlyCompleted] = useState<Set<string>>(new Set())
  const prevStatusRef = useRef<Map<string, string> | null>(null)
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const searchInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const debouncedSearchRef = useRef(debouncedSearch)
  debouncedSearchRef.current = debouncedSearch

  // Expose imperative refresh so parent can force a data fetch (e.g. after session finalization)
  const fetchDataRef = useRef<typeof fetchData | null>(null)
  useEffect(() => {
    if (refreshRef) {
      refreshRef.current = () => fetchDataRef.current?.(debouncedSearchRef.current || undefined)
    }
    return () => {
      if (refreshRef) refreshRef.current = null
    }
  }, [refreshRef])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const fetchData = useCallback(async (search?: string) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    setLoading(true)
    if (search) setSearching(true)
    try {
      // Use cogpit-memory deep search when query is >= 2 chars, otherwise list active sessions
      const sessUrl = search && search.length >= 2
        ? `/api/cogpit-search?q=${encodeURIComponent(search)}&limit=50&maxAge=365d`
        : "/api/active-sessions"
      const [sessRes, procRes] = await Promise.all([
        authFetch(sessUrl, { signal: ac.signal }),
        authFetch("/api/running-processes", { signal: ac.signal }),
      ])
      if (ac.signal.aborted) return
      if (!sessRes.ok || !procRes.ok) {
        throw new Error("Failed to fetch live data")
      }
      const [sessData, procData] = await Promise.all([
        sessRes.json(),
        procRes.json(),
      ])
      if (ac.signal.aborted) return
      setSessions(sessData)
      setProcesses(procData)
      setFetchError(null)
    } catch (err) {
      if (ac.signal.aborted) return
      setFetchError(err instanceof Error ? err.message : "Failed to load data")
    } finally {
      if (!ac.signal.aborted) {
        setLoading(false)
        setSearching(false)
      }
    }
  }, [])

  // Keep fetchDataRef in sync so the imperative refresh always calls the latest version
  fetchDataRef.current = fetchData

  useEffect(() => {
    fetchData(debouncedSearch || undefined)
  }, [debouncedSearch, fetchData])

  useEffect(() => {
    const interval = setInterval(() => fetchData(debouncedSearchRef.current || undefined), 10000)
    return () => clearInterval(interval)
  }, [fetchData])

  const procBySession = useMemo(
    () => buildProcMap(processes),
    [processes]
  )

  // Group sessions by project path
  const grouped = useMemo(() => groupByProject(sessions), [sessions])

  // Derive pending session's project path once (used for group matching)
  const pendingProjectPath = useMemo(
    () => pendingSession ? shortPath(pendingSession.cwd || dirNameToPath(pendingSession.dirName), 2) : null,
    [pendingSession],
  )

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
      setTimeout(() => fetchData(debouncedSearchRef.current || undefined), 1500)
    } catch { /* ignore */ }
    setTimeout(() => {
      setKillingPids(prev => {
        const next = new Set(prev)
        next.delete(pid)
        return next
      })
    }, 2000)
  }, [fetchData])

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
    setSessions((prev) => prev.filter((x) => x.sessionId !== s.sessionId))
  }, [onDeleteSession])

  return (
    <div className="flex h-full flex-col">
      {/* Search bar + proc count */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search sessions & prompts\u2026"
            className="w-full rounded-md border border-border/60 py-1.5 pl-7 pr-7 text-[13px] text-foreground placeholder:text-muted-foreground focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-colors"
          />
          {searchQuery && !searching && (
            <button
              onClick={() => { setSearchQuery(""); searchInputRef.current?.focus() }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
          {searching && (
            <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 size-3 animate-spin text-muted-foreground" />
          )}
        </div>
        {processes.length > 0 && (
          <span className="text-[11px] text-muted-foreground whitespace-nowrap">
            {processes.length}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 shrink-0"
          onClick={() => fetchData(debouncedSearch || undefined)}
          aria-label="Refresh live sessions"
        >
          <RefreshCw
            className={cn("size-3", loading && "animate-spin")}
          />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 px-1.5 pt-0.5 pb-3">
          {fetchError && (
            <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-red-900/50 bg-red-950/30 px-2 py-1.5">
              <AlertTriangle className="size-3 text-red-400 shrink-0" />
              <span className="text-[10px] text-red-400 flex-1 truncate">{fetchError}</span>
              <button
                onClick={() => { setFetchError(null); fetchData(debouncedSearchRef.current || undefined) }}
                className="text-[10px] text-red-400 hover:text-red-300 shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {sessions.length === 0 && !loading && !fetchError && (
            <div className="px-3 py-8 text-center">
              {debouncedSearch ? (
                <>
                  <Search className="size-5 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-[13px] text-muted-foreground">No sessions match &quot;{debouncedSearch}&quot;</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Try a different search term</p>
                </>
              ) : (
                <>
                  <Activity className="size-5 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-[13px] text-muted-foreground">No active sessions</p>
                  <p className="text-[11px] text-muted-foreground mt-1">Start Claude Code to see sessions here</p>
                </>
              )}
            </div>
          )}

          {loading && sessions.length === 0 && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Grouped sessions by project — pending session is placed inside its matching group */}
          {[...grouped.entries()].map(([projectPath, projectSessions], idx) => (
            <ProjectGroup
              key={projectPath}
              projectPath={projectPath}
              sessions={projectSessions}
              defaultCollapsed={idx >= 3}
              forceExpand={!!debouncedSearch}
              activeSessionKey={activeSessionKey}
              procBySession={procBySession}
              killingPids={killingPids}
              newlyCompleted={newlyCompleted}
              sessionNames={sessionNames}
              onSelectSession={handleSelectSession}
              onKill={handleKill}
              onDuplicateSession={onDuplicateSession}
              onDeleteSession={onDeleteSession ? handleDeleteSession : undefined}
              onRenameSession={renameSession}
              onNewSession={onNewSession}
              creatingSession={creatingSession}
              pendingSession={pendingProjectPath === projectPath ? pendingSession : undefined}
            />
          ))}

          {/* Pending session in a new group if no matching project group exists yet */}
          {pendingProjectPath && !grouped.has(pendingProjectPath) && pendingSession && (
            <ProjectGroup
              key={`pending-${pendingProjectPath}`}
              projectPath={pendingProjectPath}
              sessions={[]}
              activeSessionKey={activeSessionKey}
              procBySession={procBySession}
              killingPids={killingPids}
              newlyCompleted={newlyCompleted}
              sessionNames={sessionNames}
              onSelectSession={handleSelectSession}
              onKill={handleKill}
              onDuplicateSession={onDuplicateSession}
              onDeleteSession={onDeleteSession ? handleDeleteSession : undefined}
              onRenameSession={renameSession}
              onNewSession={onNewSession}
              creatingSession={creatingSession}
              pendingSession={pendingSession}
            />
          )}

        </div>
      </ScrollArea>
    </div>
  )
})

// -- Collapsible project group --

function ProjectGroup({
  projectPath,
  sessions,
  activeSessionKey,
  procBySession,
  killingPids,
  newlyCompleted,
  sessionNames,
  defaultCollapsed = false,
  forceExpand = false,
  onSelectSession,
  onKill,
  onDuplicateSession,
  onDeleteSession,
  onRenameSession,
  onNewSession,
  creatingSession,
  pendingSession,
}: {
  projectPath: string
  sessions: ActiveSessionInfo[]
  activeSessionKey: string | null
  procBySession: Map<string, RunningProcess>
  killingPids: Set<number>
  newlyCompleted: Set<string>
  sessionNames: Record<string, string>
  defaultCollapsed?: boolean
  forceExpand?: boolean
  onSelectSession: (dirName: string, fileName: string) => void
  onKill: (pid: number, e: React.MouseEvent) => void
  onDuplicateSession?: (dirName: string, fileName: string) => void
  onDeleteSession?: (session: ActiveSessionInfo) => void
  onRenameSession?: (sessionId: string, name: string) => void
  onNewSession?: (dirName: string, cwd?: string) => void
  creatingSession?: boolean
  pendingSession?: PendingSessionInfo | null
}) {
  const hasPending = !!pendingSession
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const isCollapsed = (forceExpand || hasPending) ? false : collapsed

  // Each row is ~32px; show 5 visible, rest scrollable
  const VISIBLE_COUNT = 5
  const ROW_HEIGHT = 32
  const totalCount = sessions.length + (hasPending ? 1 : 0)
  const needsScroll = totalCount > VISIBLE_COUNT

  return (
    <div className="flex flex-col">
      {/* Collapsible group header */}
      <div className="flex items-center gap-1 px-1.5 pt-2 pb-0.5 w-full">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-1 flex-1 min-w-0 text-left hover:bg-white/[0.02] rounded-sm transition-colors"
        >
          <ChevronRight className={cn(
            "size-2.5 text-muted-foreground/50 transition-transform duration-150 shrink-0",
            !isCollapsed && "rotate-90"
          )} />
          <FolderOpen className="size-3 text-muted-foreground/60 shrink-0" />
          <span className="text-[11px] font-medium text-muted-foreground/70 truncate">
            {projectPath}
          </span>
          <span className="text-[10px] text-muted-foreground/40 shrink-0">
            {totalCount}
          </span>
        </button>
        {onNewSession && sessions.length > 0 && (
          <button
            className="shrink-0 rounded p-0.5 text-muted-foreground/50 hover:text-foreground hover:bg-white/[0.05] transition-colors"
            disabled={creatingSession}
            onClick={(e) => {
              e.stopPropagation()
              const first = sessions[0]
              onNewSession(first.dirName, first.cwd ?? undefined)
            }}
            aria-label={`New session in ${projectPath}`}
          >
            {creatingSession ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Plus className="size-3" />
            )}
          </button>
        )}
      </div>

      {/* Session rows — left border + scrollable when > 5 */}
      {!isCollapsed && (
        <div
          className={cn(
            "flex flex-col gap-px ml-2.5 border-l border-border/40 pl-1",
            needsScroll && "overflow-y-auto scrollbar-thin"
          )}
          style={needsScroll ? { maxHeight: VISIBLE_COUNT * ROW_HEIGHT } : undefined}
        >
          {hasPending && (
            <PendingSessionRow firstMessage={pendingSession.firstMessage} />
          )}
          {sessions.map((s) => (
            <SessionRow
              key={`${s.dirName}/${s.fileName}`}
              session={s}
              isActiveSession={activeSessionKey === `${s.dirName}/${s.fileName}`}
              proc={procBySession.get(s.sessionId)}
              killingPids={killingPids}
              isNewlyCompleted={newlyCompleted.has(s.sessionId)}
              customName={sessionNames[s.sessionId]}
              onSelectSession={onSelectSession}
              onKill={onKill}
              onDuplicateSession={onDuplicateSession}
              onDeleteSession={onDeleteSession}
              onRenameSession={onRenameSession}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// -- Pending session placeholder --

function PendingSessionRow({ firstMessage }: { firstMessage?: string }) {
  return (
    <div className="relative w-full flex items-center gap-1.5 rounded-r-md px-2 py-1 text-left border-l-2 border-l-blue-500 rounded-l-none">
      <Loader2 className="size-2.5 animate-spin text-blue-400 shrink-0" />
      <span className="text-xs leading-tight truncate flex-1 text-foreground">
        {firstMessage || "New session"}
      </span>
    </div>
  )
}
