import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { authFetch } from "@/lib/auth"
import { deviceScopedKey } from "@/lib/device"
import { dirNameToPath } from "@/lib/format"
import { sortSessionsByRecency } from "@/lib/sessionOrdering"
import type { ActiveSessionInfo } from "./types"
import { usePty } from "@/contexts/PtyContext"
import { useSessionInventory } from "@/contexts/SessionInventoryContext"
import { usePendingHumanInput } from "@/contexts/PendingHumanInputContext"
import type { PendingSessionInfo } from "@/components/session-browser/types"
import { useSessionNames } from "@/hooks/useSessionNames"
import { useProjectNames } from "@/hooks/useProjectNames"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useLocalStorage } from "@/hooks/useLocalStorage"
import { hapticMedium } from "@/lib/haptics"
import { useCapability } from "@/hooks/useCapability"
import { countLiveSessions } from "./liveSessionSummary"
import { groupByProject, projectGroupKey } from "./sessionListView"
import { classifyAttention } from "./attentionGroups"
import { AttentionStrip } from "./AttentionStrip"
import { LiveSessionsFeedback, LiveSessionsToolbar } from "./LiveSessionsChrome"
import { ProjectGroupList } from "./ProjectGroupList"

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

export const LiveSessions = memo(function LiveSessions({ activeSessionKey, onSelectSession, onDuplicateSession, onDeleteSession, onNewSession, creatingSession, pendingSession, refreshRef, onPrefetchSession }: LiveSessionsProps) {
  const { names: sessionNames, rename: renameSession } = useSessionNames()
  const { names: projectNames, rename: renameProject } = useProjectNames()
  const pty = usePty()
  const canUseTerminal = useCapability("terminal")
  const canKillAny = useCapability("killAny")
  const {
    sessions,
    procBySession,
    newlyCompleted,
    loading,
    error: fetchError,
    refresh: fetchData,
    removeSession,
    acknowledgeCompleted,
  } = useSessionInventory()
  const { awaitingPermission, awaitingQuestion } = usePendingHumanInput()
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set())
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
  const sessionsRef = useRef(sessions)
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
      for (const handle of timeoutHandles) clearTimeout(handle)
      timeoutHandles.clear()
    }
  }, [])

  // Event handlers read the latest committed inventory. Keeping this write in
  // an effect avoids leaking values from a render that React later discards.
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

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
    () => classifyAttention(sessions, procBySession, newlyCompleted, awaitingPermission, awaitingQuestion),
    [sessions, procBySession, newlyCompleted, awaitingPermission, awaitingQuestion]
  )
  const hasAttention = attention.needsYou.length > 0 || attention.working.length > 0
  const showAttentionStrip = !searchQuery.trim() && hasAttention

  // Focus refresh and live polling are owned by SessionInventoryProvider so the
  // sidebar and Mission Control share a single poll.

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
    if (match) acknowledgeCompleted(match.sessionId)
    onSelectSession(dirName, fileName)
  }, [onSelectSession, acknowledgeCompleted])

  const handleDeleteSession = useCallback((s: ActiveSessionInfo) => {
    onDeleteSession?.(s.dirName, s.fileName)
    removeSession(s.sessionId)
  }, [onDeleteSession, removeSession])

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
      <LiveSessionsToolbar
        liveSessionCount={liveSessionCount}
        loading={loading}
        isMobile={isMobile}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onRefresh={() => { hapticMedium(); fetchData() }}
      />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 p-2">
          <LiveSessionsFeedback
            fetchError={fetchError}
            showEmpty={filteredSessions.length === 0 && !pendingSession && !loading && !fetchError}
            searching={Boolean(searchQuery.trim())}
            loading={loading}
            sessionCount={sessions.length}
            onRetry={fetchData}
          />

          {showAttentionStrip && (
            <div className="flex flex-col gap-3">
              <AttentionStrip
                groups={attention}
                activeSessionKey={activeSessionKey}
                procBySession={procBySession}
                killingPids={killingPids}
                sessionNames={sessionNames}
                projectNames={projectNames}
                onSelectSession={handleSelectSession}
                onKill={canKillAny ? handleKill : undefined}
                onResumeSession={canUseTerminal ? handleResumeSession : undefined}
                onPrefetchSession={onPrefetchSession}
              />
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Projects</span>
                <Separator className="flex-1" />
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
            onKill={canKillAny ? handleKill : undefined}
            onDuplicateSession={onDuplicateSession}
            onDeleteSession={onDeleteSession ? handleDeleteSession : undefined}
            onRenameSession={renameSession}
            onRenameProject={renameProject}
            onNewSession={onNewSession}
            creatingSession={creatingSession}
            onPrefetchSession={onPrefetchSession}
            onResumeSession={canUseTerminal ? handleResumeSession : undefined}
          />

        </div>
      </ScrollArea>
    </div>
  )
})
