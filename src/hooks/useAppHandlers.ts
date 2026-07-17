/**
 * App-level action handlers — session reload, duplication, deletion, branching,
 * model tracking, and settings application.
 */

import { useState, useCallback, useRef, useEffect } from "react"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "./useLiveSession"
import type { SessionAction } from "./useSessionState"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"
import { parseSubAgentPath } from "@/lib/format"
import { agentKindFromDirName } from "@/lib/sessionSource"
import type { PermissionsConfig } from "@/lib/permissions"

interface AppHandlersDeps {
  state: {
    session: ParsedSession | null
    sessionSource: SessionSource | null
  }
  dispatch: React.Dispatch<SessionAction>
  isMobile: boolean
  handleJumpToTurn: (index: number, toolCallId?: string) => void
  markPermissionsApplied: () => void
  hasPermsPendingChanges: boolean
  permissionsConfig: PermissionsConfig
  selectedModel: string
  setSelectedModel: React.Dispatch<React.SetStateAction<string>>
  selectedEffort: string
  setSelectedEffort: React.Dispatch<React.SetStateAction<string>>
  fastMode: boolean
  setFastMode: React.Dispatch<React.SetStateAction<boolean>>
  ultracode: boolean
  setUltracode: React.Dispatch<React.SetStateAction<boolean>>
  mcpConfig: string | null
  scrollRequestScrollToTop: () => void
  handleDashboardSelect: (dirName: string, fileName: string) => void
}

interface AppliedSettings {
  model: string
  effort: string
  fastMode: boolean
  ultracode: boolean
  mcpConfig: string | null
}

export function settingsApplyRequiresRestart(source: SessionSource | null): boolean {
  void source
  return false
}

interface AppHandlersResult {
  // Session reload
  reloadSession: () => Promise<void>

  // Branch modal
  branchModalTurn: number | null
  setBranchModalTurn: React.Dispatch<React.SetStateAction<number | null>>
  handleOpenBranches: (turnIndex: number) => void
  handleCloseBranchModal: () => void

  // Session operations
  handleDuplicateSessionByPath: (dirName: string, fileName: string) => Promise<void>
  handleDuplicateSession: () => void
  handleDeleteSession: (dirName: string, fileName: string) => Promise<void>
  handleBranchFromHere: (turnIndex: number) => Promise<void>

  // Mobile jump
  handleMobileJumpToTurn: (index: number, toolCallId?: string) => void

  // Settings
  hasSettingsChanges: boolean
  handleApplySettings: () => Promise<void>

  // Stop session
  handleStopSession: () => Promise<void>

  // Load session with scroll awareness
  handleLoadSessionScrollAware: (dirName: string, fileName: string) => void
}

export function useAppHandlers(deps: AppHandlersDeps): AppHandlersResult {
  const {
    state, dispatch, isMobile, handleJumpToTurn,
    markPermissionsApplied, hasPermsPendingChanges, permissionsConfig,
    selectedModel, setSelectedModel,
    selectedEffort, setSelectedEffort,
    fastMode, setFastMode,
    ultracode, setUltracode,
    mcpConfig,
    scrollRequestScrollToTop, handleDashboardSelect,
  } = deps

  // ── Session reload ─────────────────────────────────────────────────────────
  const reloadSession = useCallback(async () => {
    if (!state.sessionSource) return
    const { dirName, fileName } = state.sessionSource
    const res = await authFetch(
      `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`
    )
    if (!res.ok) return
    const rawText = await res.text()
    const newSession = parseSession(rawText)
    dispatch({
      type: "RELOAD_SESSION_CONTENT",
      session: newSession,
      source: { dirName, fileName, rawText },
    })
  }, [state.sessionSource, dispatch])

  // ── Branch modal ───────────────────────────────────────────────────────────
  const [branchModalTurn, setBranchModalTurn] = useState<number | null>(null)
  const handleOpenBranches = useCallback((turnIndex: number) => setBranchModalTurn(turnIndex), [])
  const handleCloseBranchModal = useCallback(() => setBranchModalTurn(null), [])

  // ── Duplicate session by path ──────────────────────────────────────────────
  const handleDuplicateSessionByPath = useCallback(async (dirName: string, fileName: string) => {
    try {
      const res = await authFetch("/api/branch-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirName, fileName }),
      })
      if (!res.ok) return
      const data = await res.json()
      const contentRes = await authFetch(
        `/api/sessions/${encodeURIComponent(data.dirName)}/${encodeURIComponent(data.fileName)}`
      )
      if (!contentRes.ok) return
      const rawText = await contentRes.text()
      const newSession = parseSession(rawText)
      dispatch({
        type: "LOAD_SESSION",
        session: newSession,
        source: { dirName: data.dirName, fileName: data.fileName, rawText },
        isMobile,
      })
    } catch {
      // silently fail
    }
  }, [dispatch, isMobile])

  // ── Duplicate the current session ──────────────────────────────────────────
  const handleDuplicateSession = useCallback(() => {
    if (!state.sessionSource) return
    handleDuplicateSessionByPath(state.sessionSource.dirName, state.sessionSource.fileName)
  }, [state.sessionSource, handleDuplicateSessionByPath])

  // ── Delete session ─────────────────────────────────────────────────────────
  const handleDeleteSession = useCallback(async (dirName: string, fileName: string) => {
    try {
      await authFetch("/api/delete-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirName, fileName }),
      })
    } catch {
      // silently fail
    }
  }, [])

  // ── Branch from here ───────────────────────────────────────────────────────
  const handleBranchFromHere = useCallback(async (turnIndex: number) => {
    if (!state.sessionSource) return
    const { dirName, fileName } = state.sessionSource
    try {
      const res = await authFetch("/api/branch-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dirName, fileName, turnIndex }),
      })
      if (!res.ok) return
      const data = await res.json()
      const contentRes = await authFetch(
        `/api/sessions/${encodeURIComponent(data.dirName)}/${encodeURIComponent(data.fileName)}`
      )
      if (!contentRes.ok) return
      const rawText = await contentRes.text()
      const newSession = parseSession(rawText)
      dispatch({
        type: "LOAD_SESSION",
        session: newSession,
        source: { dirName: data.dirName, fileName: data.fileName, rawText },
        isMobile,
      })
    } catch {
      // silently fail
    }
  }, [state.sessionSource, dispatch, isMobile])

  // ── Mobile jump to turn ────────────────────────────────────────────────────
  const handleMobileJumpToTurn = useCallback((index: number, toolCallId?: string) => {
    handleJumpToTurn(index, toolCallId)
    dispatch({ type: "SET_MOBILE_TAB", tab: "chat" })
  }, [handleJumpToTurn, dispatch])

  // ── Model & effort tracking ────────────────────────────────────────────────
  // In-memory map: sessionId -> settings the persistent process was spawned with.
  const [appliedSettings, setAppliedSettings] = useState<Record<string, AppliedSettings>>({})
  const selectedModelRef = useRef(selectedModel)
  selectedModelRef.current = selectedModel
  const selectedEffortRef = useRef(selectedEffort)
  selectedEffortRef.current = selectedEffort
  const mcpConfigRef = useRef(mcpConfig)
  mcpConfigRef.current = mcpConfig
  const fastModeRef = useRef(fastMode)
  fastModeRef.current = fastMode
  const ultracodeRef = useRef(ultracode)
  ultracodeRef.current = ultracode
  const permissionsConfigRef = useRef(permissionsConfig)
  permissionsConfigRef.current = permissionsConfig

  const currentSessionId = state.session?.sessionId ?? null
  const prevSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (currentSessionId === prevSessionIdRef.current) return
    prevSessionIdRef.current = currentSessionId
    if (!currentSessionId) return
    setAppliedSettings(prev => {
      if (currentSessionId in prev) {
        setSelectedModel(prev[currentSessionId].model)
        setSelectedEffort(prev[currentSessionId].effort)
        setFastMode(prev[currentSessionId].fastMode)
        setUltracode(prev[currentSessionId].ultracode)
        return prev
      }
      return {
        ...prev,
        [currentSessionId]: {
          model: selectedModelRef.current,
          effort: selectedEffortRef.current,
          fastMode: fastModeRef.current,
          ultracode: ultracodeRef.current,
          mcpConfig: mcpConfigRef.current,
        },
      }
    })
  }, [currentSessionId, setSelectedModel, setSelectedEffort, setFastMode, setUltracode])

  const applied = currentSessionId ? appliedSettings[currentSessionId] : undefined
  const mcpChanged = mcpConfig !== (applied?.mcpConfig ?? null)
  const hasSettingsChanges = applied != null &&
    (selectedModel !== applied.model ||
     selectedEffort !== applied.effort ||
     fastMode !== applied.fastMode ||
     ultracode !== applied.ultracode ||
     hasPermsPendingChanges ||
     mcpChanged)

  // ── Apply settings ─────────────────────────────────────────────────────────
  const handleApplySettings = useCallback(async () => {
    if (!currentSessionId) return
    // Settings controls update React state immediately and schedule this action
    // for the next tick. Read refs here so the native Claude update always gets
    // the value the user just selected, rather than the previous render's value.
    const nextModel = selectedModelRef.current
    const nextEffort = selectedEffortRef.current
    const nextFastMode = fastModeRef.current
    const nextUltracode = ultracodeRef.current
    const nextMcpConfig = mcpConfigRef.current
    const nextPermissions = permissionsConfigRef.current
    const agentKind = state.sessionSource?.agentKind
      ?? agentKindFromDirName(state.sessionSource?.dirName ?? null)
    if (agentKind === "claude") {
      await authFetch(`/api/claude/settings/${encodeURIComponent(currentSessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: nextModel,
          effort: nextEffort,
          fastMode: nextFastMode,
          ultracode: nextUltracode,
          mcpConfig: nextMcpConfig,
          permissionMode: nextPermissions.mode,
          allowedTools: nextPermissions.allowedTools,
          disallowedTools: nextPermissions.disallowedTools,
        }),
      })
    }
    setAppliedSettings(prev => ({
      ...prev,
      [currentSessionId]: {
        model: nextModel,
        effort: nextEffort,
        fastMode: nextFastMode,
        ultracode: nextUltracode,
        mcpConfig: nextMcpConfig,
      },
    }))
    markPermissionsApplied()
  }, [currentSessionId, state.sessionSource, markPermissionsApplied])

  // ── Stop session ───────────────────────────────────────────────────────────
  const handleStopSession = useCallback(async () => {
    if (!currentSessionId) return
    try {
      await authFetch("/api/stop-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: currentSessionId }),
      })
    } catch { /* ignore — session may already be dead */ }
  }, [currentSessionId])

  // ── Load session scroll-aware ──────────────────────────────────────────────
  const handleLoadSessionScrollAware = useCallback((dirName: string, fileName: string) => {
    if (parseSubAgentPath(fileName)) {
      scrollRequestScrollToTop()
    }
    handleDashboardSelect(dirName, fileName)
  }, [scrollRequestScrollToTop, handleDashboardSelect])

  return {
    reloadSession,
    branchModalTurn,
    setBranchModalTurn,
    handleOpenBranches,
    handleCloseBranchModal,
    handleDuplicateSessionByPath,
    handleDuplicateSession,
    handleDeleteSession,
    handleBranchFromHere,
    handleMobileJumpToTurn,
    hasSettingsChanges,
    handleApplySettings,
    handleStopSession,
    handleLoadSessionScrollAware,
  }
}
