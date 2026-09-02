import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from "react"
import { useNewSession } from "@/hooks/useNewSession"
import { authFetch } from "@/lib/auth"
import type { ParsedSession } from "../../shared/session/types"
import type { PermissionsConfig } from "@/lib/permissions"
import type { SessionAction } from "@/hooks/useSessionState"
import {
  DISCOVERED_DIRNAME_KIND,
  agentKindForDirName,
  findProjectDirNameForCwd,
  projectDirNameFor,
  type AgentKind,
} from "@/lib/agents"

interface UseProjectSessionLaunchOptions {
  permissionsConfig: PermissionsConfig
  dispatch: Dispatch<SessionAction>
  isMobile: boolean
  defaultAgentKind: AgentKind
  pendingDirName: string | null
  pendingCwd: string | null
  model: string
  effort: string
  fastMode: boolean
  ultracode: boolean
  mcpConfig: string | null
  onModelRejected: (rejectedModel: string) => void
}

/**
 * Owns lazy new-session launch state and agent-aware project resolution.
 *
 * One agent's dirName is a lossy encoding of the cwd that can only be looked
 * up, never recomputed, so a pending session remembers that agent's matching
 * directory — whichever agent it starts in — and the composer can switch
 * agents without losing the real cwd.
 */
export function useProjectSessionLaunch({
  permissionsConfig,
  dispatch,
  isMobile,
  defaultAgentKind,
  pendingDirName,
  pendingCwd,
  model,
  effort,
  fastMode,
  ultracode,
  mcpConfig,
  onModelRejected,
}: UseProjectSessionLaunchOptions) {
  const sessionFinalizedRef = useRef<((parsed: ParsedSession) => void) | null>(null)
  const liveSessionsRefreshRef = useRef<(() => void) | null>(null)
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null)

  const newSession = useNewSession({
    permissionsConfig,
    dispatch,
    isMobile,
    onSessionFinalized: (parsed) => {
      sessionFinalizedRef.current?.(parsed)
      // Refresh once optimistically and again after active-session indexing.
      setTimeout(() => liveSessionsRefreshRef.current?.(), 300)
      setTimeout(() => liveSessionsRefreshRef.current?.(), 2000)
    },
    onCreateStarted: setPendingFirstMessage,
    onModelRejected,
    model,
    effort,
    fastMode,
    ultracode,
    mcpConfig,
  })
  const beginNewSession = newSession.handleNewSession

  const [pendingAgentSource, setPendingAgentSource] = useState<{
    /** The lossy-encoded agent's directory for `cwd`, as the server knows it. */
    discoveredDirName: string
    cwd: string
  } | null>(null)
  const discoveredDirNameCacheRef = useRef(new Map<string, string | null>())

  const resolveDiscoveredDirName = useCallback(async (cwd: string): Promise<string | null> => {
    if (DISCOVERED_DIRNAME_KIND === null) return null
    const cache = discoveredDirNameCacheRef.current
    if (cache.has(cwd)) {
      return cache.get(cwd) ?? null
    }

    try {
      const response = await authFetch("/api/projects")
      if (!response.ok) {
        cache.set(cwd, null)
        return null
      }
      const projects = await response.json() as Array<{ dirName: string; path: string }>
      const match = findProjectDirNameForCwd(projects, cwd, DISCOVERED_DIRNAME_KIND)
      cache.set(cwd, match)
      return match
    } catch {
      cache.set(cwd, null)
      return null
    }
  }, [])

  const handleStartNewSession = useCallback(async (dirName: string, cwd?: string) => {
    const normalizedCwd = cwd ?? null
    if (!normalizedCwd) {
      setPendingAgentSource(null)
      beginNewSession(dirName)
      return
    }

    // Starting in the lossy agent's own project re-derives its dirName from
    // the cwd, which normalises a stale one; starting anywhere else has to
    // look it up.
    const startsInLossyKind = agentKindForDirName(dirName) === DISCOVERED_DIRNAME_KIND
      ? DISCOVERED_DIRNAME_KIND
      : null
    const discoveredDirName = startsInLossyKind
      ? projectDirNameFor(startsInLossyKind, normalizedCwd)
      : await resolveDiscoveredDirName(normalizedCwd)

    setPendingAgentSource(discoveredDirName ? { discoveredDirName, cwd: normalizedCwd } : null)
    beginNewSession(
      startsInLossyKind && discoveredDirName ? discoveredDirName : dirName,
      normalizedCwd,
    )
  }, [beginNewSession, resolveDiscoveredDirName])

  const handleStartNewFolder = useCallback((cwd: string) => {
    const dirName = projectDirNameFor(defaultAgentKind, cwd)
    void handleStartNewSession(dirName, cwd)
  }, [defaultAgentKind, handleStartNewSession])

  const handlePendingSessionAgentChange = useCallback((agentKind: AgentKind) => {
    if (!pendingAgentSource) return
    const nextDirName = projectDirNameFor(
      agentKind,
      pendingAgentSource.cwd,
      pendingAgentSource.discoveredDirName,
    )
    beginNewSession(nextDirName, pendingAgentSource.cwd)
  }, [pendingAgentSource, beginNewSession])

  const pendingSessionInfo = useMemo(() => {
    if (!newSession.creatingSession || !pendingDirName) return null
    return {
      dirName: pendingDirName,
      cwd: pendingCwd,
      firstMessage: pendingFirstMessage ?? undefined,
    }
  }, [newSession.creatingSession, pendingDirName, pendingCwd, pendingFirstMessage])

  useEffect(() => {
    if (!pendingDirName) {
      setPendingFirstMessage(null)
      setPendingAgentSource(null)
    }
  }, [pendingDirName])

  return {
    creatingSession: newSession.creatingSession,
    createError: newSession.createError,
    clearCreateError: newSession.clearCreateError,
    createAndSend: newSession.createAndSend,
    cancelCreation: newSession.cancelCreation,
    worktreeEnabled: newSession.worktreeEnabled,
    setWorktreeEnabled: newSession.setWorktreeEnabled,
    sessionFinalizedRef,
    liveSessionsRefreshRef,
    pendingSessionInfo,
    pendingAgentKindChange: pendingAgentSource ? handlePendingSessionAgentChange : undefined,
    handleStartNewSession,
    handleStartNewFolder,
  }
}
