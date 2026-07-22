import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch } from "react"
import { useNewSession } from "@/hooks/useNewSession"
import { authFetch } from "@/lib/auth"
import type { ParsedSession } from "@/lib/types"
import type { PermissionsConfig } from "@/lib/permissions"
import type { SessionAction } from "@/hooks/useSessionState"
import {
  findClaudeProjectDirNameForCwd,
  isCodexDirName,
  projectDirNameForAgent,
  projectDirNameForNewFolder,
  type AgentKind,
} from "@/lib/sessionSource"

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
  onCodexModelRejected: (rejectedModel: string) => void
}

/**
 * Owns lazy new-session launch state and provider-aware project resolution.
 * A Codex project remembers its matching Claude directory so the pending
 * composer can switch agents without losing the real cwd.
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
  onCodexModelRejected,
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
    onCodexModelRejected,
    model,
    effort,
    fastMode,
    ultracode,
    mcpConfig,
  })
  const beginNewSession = newSession.handleNewSession

  const [pendingAgentSource, setPendingAgentSource] = useState<{
    claudeDirName: string
    cwd: string
  } | null>(null)
  const claudeProjectDirCacheRef = useRef(new Map<string, string | null>())

  const resolveClaudeProjectDirName = useCallback(async (cwd: string): Promise<string | null> => {
    const cache = claudeProjectDirCacheRef.current
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
      const match = findClaudeProjectDirNameForCwd(projects, cwd)
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

    const startsInCodex = isCodexDirName(dirName)
    const claudeDirName = startsInCodex
      ? await resolveClaudeProjectDirName(normalizedCwd)
      : projectDirNameForNewFolder(normalizedCwd, "claude")

    setPendingAgentSource(claudeDirName ? { claudeDirName, cwd: normalizedCwd } : null)
    beginNewSession(
      startsInCodex || !claudeDirName ? dirName : claudeDirName,
      normalizedCwd,
    )
  }, [beginNewSession, resolveClaudeProjectDirName])

  const handleStartNewFolder = useCallback((cwd: string) => {
    const dirName = projectDirNameForNewFolder(cwd, defaultAgentKind)
    void handleStartNewSession(dirName, cwd)
  }, [defaultAgentKind, handleStartNewSession])

  const handlePendingSessionAgentChange = useCallback((agentKind: AgentKind) => {
    if (!pendingAgentSource) return
    const nextDirName = projectDirNameForAgent(
      pendingAgentSource.claudeDirName,
      pendingAgentSource.cwd,
      agentKind,
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
