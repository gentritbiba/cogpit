import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react"
import { toast } from "sonner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { authFetch } from "@/lib/auth"
import { deviceScopedKey } from "@/lib/device"
import { dirNameToPath } from "@/lib/format"
import { sortSessionsByRecency } from "../../../shared/session-ordering"
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
import { usePullRequestSessionSearch } from "@/hooks/usePullRequestSessionSearch"
import { matchesSessionSearch } from "../../../shared/session/sessionSearch"
import { agentKindForDirName, getResumeSpawn } from "@/lib/agents"
import { setSessionsArchived } from "@/lib/sessionArchive"
import { isSessionLive, listedSessions, projectGroupKey, sessionTitle } from "./sessionListView"
import { classifyAttention } from "./attentionGroups"
import { AttentionStrip } from "./AttentionStrip"
import { LiveSessionsFeedback, LiveSessionsToolbar } from "./LiveSessionsChrome"
import { SessionCardList, type SessionListSharedProps } from "./SessionCardList"
import { ProjectScopePicker } from "./ProjectScopePicker"
import { mergeSessions, projectScopeOptions, scopeSessions } from "./projectScope"
import { useOlderSessions, type OlderSessionsTarget } from "./useOlderSessions"

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

const ALL_PROJECTS: OlderSessionsTarget = { key: "all" }

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
    showArchived,
    setShowArchived,
    setSearchActive,
    archivedCount,
    setArchived,
  } = useSessionInventory()
  const {
    awaitingPermission,
    awaitingQuestion,
    awaitingElicitation,
    awaitingDialog,
    awaitingPlan,
  } = usePendingHumanInput()
  const awaitingPrompt = useMemo(
    () => new Set([...awaitingElicitation, ...awaitingDialog]),
    [awaitingElicitation, awaitingDialog],
  )
  const [killingPids, setKillingPids] = useState<Set<number>>(new Set())
  const [searchQuery, setSearchQuery] = useState("")
  // Which project the sidebar is focused on; null lists every project. Kept
  // per device, since projects differ between devices and DeviceRoot remounts
  // on a device change.
  const [projectScope, setProjectScope] = useLocalStorage<string | null>(
    deviceScopedKey("live-sessions-project-scope"),
    null,
  )
  const searching = Boolean(searchQuery.trim())
  // A search looks through everything, so archived sessions join the list
  // while one is active even when the toggle is off.
  const listArchived = showArchived || searching
  useEffect(() => {
    setSearchActive(searching)
    return () => setSearchActive(false)
  }, [searching, setSearchActive])
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
  const pullRequestResults = usePullRequestSessionSearch<ActiveSessionInfo>(searchQuery)

  const visibleSessions = useMemo(
    () => listedSessions(sessions, listArchived),
    [sessions, listArchived],
  )
  const hiddenArchivedCount = listArchived ? 0 : archivedCount

  // Cross-project triage for the attention strip (independent of search)
  const attention = useMemo(
    () => classifyAttention(
      visibleSessions,
      procBySession,
      newlyCompleted,
      awaitingPermission,
      awaitingQuestion,
      awaitingPrompt,
      awaitingPlan,
    ),
    [
      visibleSessions,
      procBySession,
      newlyCompleted,
      awaitingPermission,
      awaitingQuestion,
      awaitingPrompt,
      awaitingPlan,
    ],
  )
  const needsYouIds = useMemo(
    () => new Set(attention.needsYou.map((item) => item.session.sessionId)),
    [attention],
  )
  const scopeOptions = useMemo(
    () => projectScopeOptions(visibleSessions, procBySession, projectNames, needsYouIds),
    [visibleSessions, procBySession, projectNames, needsYouIds],
  )
  const focusedProject = projectScope === null
    ? null
    : scopeOptions.find((option) => option.key === projectScope) ?? null
  const focusedProjectLabel = focusedProject?.customName ?? projectScope
  const older = useOlderSessions(projectScope === null ? ALL_PROJECTS : focusedProject, listArchived)
  const scopedSessions = useMemo(
    () => mergeSessions(scopeSessions(visibleSessions, projectScope), older.sessions),
    [visibleSessions, projectScope, older.sessions],
  )

  const locallyFilteredSessions = useMemo(() => {
    if (!searching) return scopedSessions
    return scopedSessions.filter((session) => {
      const customSessionName = sessionNames[session.sessionId]
      const customProjectName = projectNames[session.dirName]
      return matchesSessionSearch(session, searchQuery, [customSessionName, customProjectName])
    })
  }, [scopedSessions, searching, searchQuery, sessionNames, projectNames])
  const filteredSessions = useMemo(
    () => (pullRequestResults.results
      ? scopeSessions(pullRequestResults.results, projectScope)
      : locallyFilteredSessions),
    [pullRequestResults.results, projectScope, locallyFilteredSessions],
  )

  const hasAttention = attention.needsYou.length > 0 || attention.working.length > 0
  // Focused, every card already carries its status, so the strip would repeat it.
  const showAttentionStrip = !searching && hasAttention && projectScope === null
  const focusedArchivable = useMemo(
    () => (projectScope === null
      ? []
      : scopedSessions.filter((session) => !session.archived && !isSessionLive(session, procBySession))),
    [projectScope, scopedSessions, procBySession],
  )

  // Focus refresh and live polling are owned by SessionInventoryProvider so the
  // sidebar and Mission Control share a single poll.

  // A focused sidebar shows a new session only when it belongs to that project.
  const showPendingSession = projectScope === null || (pendingSession != null
    && projectGroupKey(pendingSession.cwd || dirNameToPath(pendingSession.dirName)) === projectScope)

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

  // Archive changes apply instantly and roll back if the server rejects them.
  // The toast carries an undo so a slip never needs the archived view to fix.
  // A poll that started before the change could land after it, so the list
  // is refetched once the server has it.
  const applyArchive = useCallback(async (
    sessionIds: string[],
    archived: boolean,
    message: string | null,
  ) => {
    setArchived(sessionIds, archived)
    const ok = await setSessionsArchived(sessionIds, archived)
    if (!ok) {
      setArchived(sessionIds, !archived)
      toast.error(archived ? "Could not archive session" : "Could not restore session")
      return
    }
    fetchData()
    if (message) {
      toast(message, {
        action: { label: "Undo", onClick: () => { void applyArchive(sessionIds, !archived, null) } },
      })
    }
  }, [setArchived, fetchData])

  const handleArchiveSession = useCallback((s: ActiveSessionInfo) => {
    void applyArchive([s.sessionId], true, `Archived “${sessionTitle(s, sessionNames[s.sessionId])}”`)
  }, [applyArchive, sessionNames])

  const handleUnarchiveSession = useCallback((s: ActiveSessionInfo) => {
    void applyArchive([s.sessionId], false, `Restored “${sessionTitle(s, sessionNames[s.sessionId])}”`)
  }, [applyArchive, sessionNames])

  const handleArchiveSessions = useCallback((toArchive: ActiveSessionInfo[]) => {
    if (toArchive.length === 0) return
    const ids = toArchive.map((s) => s.sessionId)
    void applyArchive(ids, true, `Archived ${ids.length} ${ids.length === 1 ? "session" : "sessions"}`)
  }, [applyArchive])

  const handleResumeSession = useCallback((sessionId: string, cwd: string | undefined, dirName: string) => {
    const { command, args } = getResumeSpawn(agentKindForDirName(dirName), sessionId)
    const id = `resume_${crypto.randomUUID().slice(0, 8)}`
    pty.send({
      type: "spawn",
      id,
      name: `Resume ${sessionId.slice(0, 8)}`,
      command,
      args,
      cwd: cwd ?? undefined,
      metadata: { type: "terminal" },
    })
    // Refresh sessions after a brief delay to pick up any status change
    scheduleTimeout(fetchData, 3000)
  }, [pty, fetchData, scheduleTimeout])

  // Both list variants render the same sessions with the same actions; only
  // the grouping around them differs.
  const sessionListProps: SessionListSharedProps = {
    activeSessionKey,
    procBySession,
    killingPids,
    newlyCompleted,
    sessionNames,
    projectNames,
    onSelectSession: handleSelectSession,
    onKill: canKillAny ? handleKill : undefined,
    onDuplicateSession,
    onDeleteSession: onDeleteSession ? handleDeleteSession : undefined,
    onArchiveSession: handleArchiveSession,
    onUnarchiveSession: handleUnarchiveSession,
    onRenameSession: renameSession,
    onPrefetchSession,
    onResumeSession: canUseTerminal ? handleResumeSession : undefined,
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LiveSessionsToolbar
        loading={loading}
        isMobile={isMobile}
        searchQuery={searchQuery}
        searchLoading={pullRequestResults.loading}
        showArchived={showArchived}
        archivedCount={archivedCount}
        onSearchQueryChange={setSearchQuery}
        onToggleShowArchived={() => setShowArchived(!showArchived)}
        onRefresh={() => { hapticMedium(); fetchData() }}
      />

      <ProjectScopePicker
        options={scopeOptions}
        value={projectScope}
        focused={focusedProject}
        totalSessions={visibleSessions.length}
        onChange={setProjectScope}
        onNewSession={onNewSession}
        creatingSession={creatingSession}
        onRenameProject={renameProject}
        archivableCount={focusedArchivable.length}
        onArchiveIdle={() => handleArchiveSessions(focusedArchivable)}
      />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 p-2">
          <LiveSessionsFeedback
            fetchError={pullRequestResults.error ?? fetchError}
            showEmpty={filteredSessions.length === 0 && !(pendingSession && showPendingSession)
              && !loading && !pullRequestResults.loading && !fetchError && !pullRequestResults.error}
            searching={searching}
            loading={loading || pullRequestResults.loading}
            sessionCount={pullRequestResults.active ? filteredSessions.length : visibleSessions.length}
            hiddenArchivedCount={hiddenArchivedCount}
            focusedProject={focusedProjectLabel}
            onShowAllProjects={() => setProjectScope(null)}
            onShowArchived={() => setShowArchived(true)}
            onRetry={pullRequestResults.error ? pullRequestResults.refresh : fetchData}
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
              <Separator />
            </div>
          )}

          <SessionCardList
            {...sessionListProps}
            sessions={filteredSessions}
            pendingSession={showPendingSession ? pendingSession : null}
            older={{
              canLoad: (projectScope === null || Boolean(focusedProject)) && !older.loaded && !searching,
              loading: older.loading,
              load: older.load,
            }}
          />

        </div>
      </ScrollArea>
    </div>
  )
})
