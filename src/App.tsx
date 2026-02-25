import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { Loader2, AlertTriangle, RefreshCw, WifiOff, X, TerminalSquare, Code2, FolderSearch, Bot } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SessionBrowser } from "@/components/SessionBrowser"
import { StatsPanel } from "@/components/StatsPanel"
import { WorktreePanel } from "@/components/WorktreePanel"
import { SessionSetupPanel } from "@/components/SessionSetupPanel"
import { FileChangesPanel } from "@/components/FileChangesPanel"
import { TeamsDashboard } from "@/components/TeamsDashboard"
import { TeamMembersBar } from "@/components/TeamMembersBar"
import { Dashboard } from "@/components/Dashboard"
import { MobileNav } from "@/components/MobileNav"
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput"
import { ServerPanel } from "@/components/ServerPanel"
import { PermissionsPanel } from "@/components/PermissionsPanel"
import { UndoConfirmDialog } from "@/components/UndoConfirmDialog"
import { BranchModal } from "@/components/BranchModal"
import { SetupScreen } from "@/components/SetupScreen"
import { ConfigDialog } from "@/components/ConfigDialog"
import { ProjectSwitcherModal } from "@/components/ProjectSwitcherModal"
import { ThemeSelectorModal } from "@/components/ThemeSelectorModal"
import { DesktopHeader } from "@/components/DesktopHeader"
import { SessionInfoBar } from "@/components/SessionInfoBar"
import { ChatArea } from "@/components/ChatArea"
import { PendingTurnPreview } from "@/components/PendingTurnPreview"
import { TodoProgressPanel } from "@/components/TodoProgressPanel"
import { useLiveSession } from "@/hooks/useLiveSession"
import { useSessionTeam } from "@/hooks/useSessionTeam"
import { usePtyChat } from "@/hooks/usePtyChat"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useSessionState } from "@/hooks/useSessionState"
import { useChatScroll } from "@/hooks/useChatScroll"
import { useSessionActions } from "@/hooks/useSessionActions"
import { useUrlSync } from "@/hooks/useUrlSync"
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts"
import { useTheme } from "@/hooks/useTheme"
import { useSessionHistory } from "@/hooks/useSessionHistory"
import { usePermissions } from "@/hooks/usePermissions"
import { useUndoRedo } from "@/hooks/useUndoRedo"
import { useAppConfig } from "@/hooks/useAppConfig"
import { useServerPanel } from "@/hooks/useServerPanel"
import { useNewSession } from "@/hooks/useNewSession"
import { useWorktrees } from "@/hooks/useWorktrees"
import { useKillAll } from "@/hooks/useKillAll"
import { useTodoProgress } from "@/hooks/useTodoProgress"
import { useBackgroundAgents } from "@/hooks/useBackgroundAgents"
import { useSlashSuggestions } from "@/hooks/useSlashSuggestions"
import { parseSession, detectPendingInteraction } from "@/lib/parser"
import { dirNameToPath, shortPath, parseSubAgentPath } from "@/lib/format"
import type { ParsedSession } from "@/lib/types"
import { authFetch } from "@/lib/auth"
import { LoginScreen } from "@/components/LoginScreen"
import { useNetworkAuth } from "@/hooks/useNetworkAuth"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable"

export default function App() {
  const config = useAppConfig()
  const networkAuth = useNetworkAuth()
  const isMobile = useIsMobile()
  const themeCtx = useTheme()
  const [state, dispatch] = useSessionState()

  // Local UI state
  const [showSidebar, setShowSidebar] = useState(true)
  const [showStats, setShowStats] = useState(true)
  const [showWorktrees, setShowWorktrees] = useState(false)
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false)
  const [showThemeSelector, setShowThemeSelector] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const chatInputRef = useRef<ChatInputHandle>(null)

  // Stable callbacks
  const handleSidebarTabChange = useCallback(
    (tab: "browse" | "teams") => dispatch({ type: "SET_SIDEBAR_TAB", tab }),
    [dispatch]
  )
  const handleToggleSidebar = useCallback(() => setShowSidebar((p) => !p), [])
  const handleToggleStats = useCallback(() => setShowStats((p) => !p), [])
  const handleToggleWorktrees = useCallback(() => setShowWorktrees((p) => !p), [])
  const handleOpenProjectSwitcher = useCallback(() => setShowProjectSwitcher(true), [])
  const handleCloseProjectSwitcher = useCallback(() => setShowProjectSwitcher(false), [])
  const handleToggleThemeSelector = useCallback(() => setShowThemeSelector((p) => !p), [])

  // Real filesystem path for the pending (pre-created) session.
  // pendingCwd is the authoritative path; dirNameToPath is a lossy fallback.
  const pendingPath = state.pendingCwd ?? (state.pendingDirName ? dirNameToPath(state.pendingDirName) : null)

  const handleOpenTerminal = useCallback(() => {
    const projectPath = state.session?.cwd
      ?? pendingPath
      ?? (state.sessionSource?.dirName ? dirNameToPath(state.sessionSource.dirName) : null)
      ?? (state.dashboardProject ? dirNameToPath(state.dashboardProject) : null)
    if (!projectPath) { console.warn("[open-terminal] no project path available"); return }
    authFetch("/api/open-terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    }).then((res) => {
      if (!res.ok) res.json().then((d) => console.error("[open-terminal]", d.error)).catch(() => {})
    }).catch((err) => console.error("[open-terminal] fetch failed:", err))
  }, [state.session?.cwd, pendingPath, state.sessionSource?.dirName, state.dashboardProject])
  const handleCloseThemeSelector = useCallback(() => setShowThemeSelector(false), [])
  const handleToggleExpandAll = useCallback(() => dispatch({ type: "TOGGLE_EXPAND_ALL" }), [dispatch])
  const handleSearchChange = useCallback((q: string) => dispatch({ type: "SET_SEARCH_QUERY", value: q }), [dispatch])
  const handleSelectProject = useCallback((dirName: string | null) => dispatch({ type: "SET_DASHBOARD_PROJECT", dirName }), [dispatch])

  // Server panel state
  const serverPanel = useServerPanel(state.session?.sessionId)

  // TODO progress from session's TodoWrite tool calls
  const todoProgress = useTodoProgress(state.session ?? null)

  // Derive the current project dirName from session, pending session, or dashboard selection
  const currentDirName = state.sessionSource?.dirName ?? state.pendingDirName ?? state.dashboardProject ?? null

  // Worktree data — only fetched when panel is open
  const worktreeData = useWorktrees(showWorktrees ? currentDirName : null)

  // Check if session has any Edit/Write tool calls for the file changes panel
  const hasFileChanges = useMemo(() => {
    if (!state.session) return false
    return state.session.turns.some((turn) =>
      turn.toolCalls.some((tc) => tc.name === "Edit" || tc.name === "Write")
    )
  }, [state.session])

  // Detect pending interactive prompts (plan approval, user questions)
  const pendingInteractionRef = useRef<ReturnType<typeof detectPendingInteraction>>(null)
  const pendingInteraction = useMemo(() => {
    const next = state.session ? detectPendingInteraction(state.session) : null
    if (JSON.stringify(next) === JSON.stringify(pendingInteractionRef.current)) {
      return pendingInteractionRef.current
    }
    pendingInteractionRef.current = next
    return next
  }, [state.session])

  // Live session streaming
  const { isLive, sseState } = useLiveSession(state.sessionSource, (updated) => {
    dispatch({ type: "UPDATE_SESSION", session: updated })
  })

  // Background agents (shared between notifications + StatsPanel)
  const backgroundAgents = useBackgroundAgents(state.session?.cwd ?? null)

  // Slash command/skill suggestions
  const slashSuggestions = useSlashSuggestions(state.session?.cwd ?? pendingPath ?? undefined)


  // Permissions management
  const perms = usePermissions()

  // Model override (empty = use session default)
  const [selectedModel, setSelectedModel] = useState("")

  // In-memory map: sessionId → model the persistent process was spawned with.
  // No localStorage — processes don't survive page reload, so stale data would be wrong.
  const [appliedModels, setAppliedModels] = useState<Record<string, string>>({})
  const selectedModelRef = useRef(selectedModel)
  selectedModelRef.current = selectedModel

  // New session creation (lazy — no backend call until first message)
  // Declared before usePtyChat because it provides the onCreateSession callback.
  const sessionFinalizedRef = useRef<((parsed: ParsedSession) => void) | null>(null)
  const {
    creatingSession,
    createError,
    clearCreateError,
    handleNewSession,
    createAndSend,
    worktreeEnabled,
    setWorktreeEnabled,
    worktreeName: newSessionWorktreeName,
    setWorktreeName: setNewSessionWorktreeName,
  } = useNewSession({
    permissionsConfig: perms.config,
    dispatch,
    isMobile,
    onSessionFinalized: (parsed) => {
      sessionFinalizedRef.current?.(parsed)
    },
    model: selectedModel,
  })

  // Claude chat
  const claudeChat = usePtyChat({
    sessionSource: state.sessionSource,
    parsedSessionId: state.session?.sessionId ?? null,
    cwd: state.session?.cwd,
    permissions: perms.config,
    onPermissionsApplied: perms.markApplied,
    model: selectedModel,
    onCreateSession: state.pendingDirName ? createAndSend : undefined,
  })

  // Detect if session belongs to a team
  const teamContext = useSessionTeam(state.sessionSource?.fileName ?? null)

  // Sync currentMemberName from team context detection
  useEffect(() => {
    if (teamContext?.currentMemberName) {
      dispatch({ type: "SET_CURRENT_MEMBER_NAME", name: teamContext.currentMemberName })
    } else if (!teamContext) {
      dispatch({ type: "SET_CURRENT_MEMBER_NAME", name: null })
    }
  }, [teamContext?.currentMemberName, teamContext, dispatch])

  // Guard: reset mobile tab when session/team context disappears
  useEffect(() => {
    if (!isMobile) return
    dispatch({
      type: "GUARD_MOBILE_TAB",
      hasSession: !!state.session || !!state.pendingDirName,
      hasTeam: !!teamContext,
    })
  }, [state.session, state.pendingDirName, teamContext, state.mobileTab, isMobile, dispatch])

  // Scroll management
  const scroll = useChatScroll({
    session: state.session,
    isLive,
    pendingMessage: claudeChat.pendingMessage,
    clearPending: claudeChat.clearPending,
    sessionChangeKey: state.sessionChangeKey,
  })

  // Wire up the session finalized ref now that scroll is available
  sessionFinalizedRef.current = () => {
    // Reset to 0 so useChatScroll detects "new turns" and clears pendingMessage
    scroll.resetTurnCount(0)
    scroll.scrollToBottomInstant()
  }

  // Session action handlers
  const actions = useSessionActions({
    dispatch,
    isMobile,
    teamContext,
    scrollToBottomInstant: scroll.scrollToBottomInstant,
    resetTurnCount: scroll.resetTurnCount,
  })

  // Sync URL <-> state
  useUrlSync({
    state,
    dispatch,
    isMobile,
    resetTurnCount: scroll.resetTurnCount,
    scrollToBottomInstant: scroll.scrollToBottomInstant,
  })

  // MRU session history for Ctrl+Tab switching
  const sessionHistory = useSessionHistory()

  // Track session visits for history
  useEffect(() => {
    if (state.sessionSource) {
      sessionHistory.push(state.sessionSource.dirName, state.sessionSource.fileName)
    }
  }, [state.sessionSource, sessionHistory.push])

  // Keyboard shortcuts
  useKeyboardShortcuts({
    isMobile,
    searchInputRef,
    chatInputRef,
    dispatch,
    onToggleSidebar: handleToggleSidebar,
    onOpenProjectSwitcher: handleOpenProjectSwitcher,
    onOpenThemeSelector: handleToggleThemeSelector,
    onOpenTerminal: handleOpenTerminal,
    onHistoryBack: sessionHistory.goBack,
    onHistoryForward: sessionHistory.goForward,
    onNavigateToSession: actions.handleDashboardSelect,
    onCommitNavigation: sessionHistory.commitNavigation,
  })

  // Reload session from server (used after undo/redo JSONL mutations)
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

  // Undo/redo system
  const undoRedo = useUndoRedo(state.session, state.sessionSource, reloadSession)

  // Branch modal state
  const [branchModalTurn, setBranchModalTurn] = useState<number | null>(null)
  const branchModalBranches = branchModalTurn !== null ? undoRedo.branchesAtTurn(branchModalTurn) : []
  const handleOpenBranches = useCallback((turnIndex: number) => setBranchModalTurn(turnIndex), [])
  const handleCloseBranchModal = useCallback(() => setBranchModalTurn(null), [])
  const handleRedoToTurn = useCallback((branchId: string, archiveTurnIdx: number) => {
    undoRedo.requestBranchSwitch(branchId, archiveTurnIdx)
    setBranchModalTurn(null)
  }, [undoRedo.requestBranchSwitch])
  const handleRedoEntireBranch = useCallback((branchId: string) => {
    undoRedo.requestBranchSwitch(branchId)
    setBranchModalTurn(null)
  }, [undoRedo.requestBranchSwitch])

  // Duplicate any session by dirName/fileName and load it
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

  // Duplicate the current session (full copy) — used by SessionInfoBar
  const handleDuplicateSession = useCallback(() => {
    if (!state.sessionSource) return
    handleDuplicateSessionByPath(state.sessionSource.dirName, state.sessionSource.fileName)
  }, [state.sessionSource, handleDuplicateSessionByPath])

  // Delete any session by dirName/fileName
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

  // Duplicate from a specific turn (creates a new session truncated at that turn)
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

  // Mobile StatsPanel jump callback
  const handleMobileJumpToTurn = useCallback((index: number, toolCallId?: string) => {
    actions.handleJumpToTurn(index, toolCallId)
    dispatch({ type: "SET_MOBILE_TAB", tab: "chat" })
  }, [actions.handleJumpToTurn, dispatch])

  // Kill-all handler
  const { killing, handleKillAll } = useKillAll()

  // When session changes: record baseline for new sessions, restore model for revisits
  const currentSessionId = state.session?.sessionId ?? null
  const prevSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (currentSessionId === prevSessionIdRef.current) return
    prevSessionIdRef.current = currentSessionId
    if (!currentSessionId) return
    setAppliedModels(prev => {
      if (currentSessionId in prev) {
        setSelectedModel(prev[currentSessionId])
        return prev
      }
      return { ...prev, [currentSessionId]: selectedModelRef.current }
    })
  }, [currentSessionId])

  // Detect if model or permissions have changed from what the persistent process uses
  const hasSettingsChanges = currentSessionId != null &&
    currentSessionId in appliedModels &&
    (selectedModel !== appliedModels[currentSessionId] || perms.hasPendingChanges)

  // Restart the persistent process to apply new model/permissions
  const handleApplySettings = useCallback(async () => {
    if (!currentSessionId) return
    await authFetch("/api/stop-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentSessionId }),
    })
    setAppliedModels(prev => ({ ...prev, [currentSessionId]: selectedModel }))
    perms.markApplied()
  }, [currentSessionId, selectedModel, perms])

  // Stop/kill the running session process
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

  // Permissions panel element (shared between desktop/mobile StatsPanel)
  const permissionsPanelNode = useMemo(() => (
    <PermissionsPanel
      config={perms.config}
      hasPendingChanges={perms.hasPendingChanges}
      onSetMode={perms.setMode}
      onToggleAllowed={perms.toggleAllowedTool}
      onToggleDisallowed={perms.toggleDisallowedTool}
      onReset={perms.resetToDefault}
    />
  ), [perms.config, perms.hasPendingChanges, perms.setMode, perms.toggleAllowedTool, perms.toggleDisallowedTool, perms.resetToDefault])

  // Active session key for sidebar highlighting
  const activeSessionKey = state.sessionSource
    ? `${state.sessionSource.dirName}/${state.sessionSource.fileName}`
    : null

  // Navigate back to parent session when viewing a sub-agent
  // Team members also live under subagents/ but are NOT read-only subagent views —
  // they should get the normal chat input so users can send prompts directly.
  const subAgentInfo = state.sessionSource ? parseSubAgentPath(state.sessionSource.fileName) : null
  const isTeamMemberView = subAgentInfo !== null && !!teamContext?.currentMemberName
  const isSubAgentView = subAgentInfo !== null && !isTeamMemberView

  const handleBackToMain = useCallback(() => {
    if (!state.sessionSource || !subAgentInfo) return
    actions.handleDashboardSelect(state.sessionSource.dirName, subAgentInfo.parentFileName)
  }, [state.sessionSource, subAgentInfo, actions.handleDashboardSelect])

  // Load a session — sub-agent sessions scroll to top, others scroll to bottom
  const handleLoadSessionScrollAware = useCallback((dirName: string, fileName: string) => {
    if (parseSubAgentPath(fileName)) {
      scroll.requestScrollToTop()
    }
    actions.handleDashboardSelect(dirName, fileName)
  }, [scroll.requestScrollToTop, actions.handleDashboardSelect])

  // Read-only banner shown when viewing a sub-agent session (replaces chat input)
  const subAgentReadOnlyNode = isSubAgentView ? (
    <div className="shrink-0 flex items-center justify-center gap-2 border-t border-border/50 bg-elevation-1 px-4 py-2.5">
      <Bot className="size-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">Viewing sub-agent session (read-only)</span>
    </div>
  ) : null

  // Collect all error messages for toast display
  const activeError = actions.loadError || createError || null
  const clearActiveError = actions.loadError ? actions.clearLoadError : createError ? clearCreateError : undefined

  // Auto-dismiss error toasts after 8 seconds
  useEffect(() => {
    if (!activeError || !clearActiveError) return
    const timer = setTimeout(clearActiveError, 8000)
    return () => clearTimeout(timer)
  }, [activeError, clearActiveError])

  // ─── AUTH GATE (remote clients only) ────────────────────────────────────────
  if (!networkAuth.authenticated) {
    return <LoginScreen onAuthenticated={networkAuth.handleAuthenticated} />
  }

  // ─── CONFIG GATE ────────────────────────────────────────────────────────────
  if (config.configLoading) {
    return (
      <div className="dark flex h-dvh items-center justify-center bg-elevation-0" role="status" aria-label="Loading">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (config.configError) {
    return (
      <div className="dark flex h-dvh flex-col items-center justify-center gap-4 bg-elevation-0 text-foreground">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20">
          <AlertTriangle className="size-7 text-red-400" />
        </div>
        <div className="text-center space-y-1">
          <h2 className="text-sm font-medium text-foreground">Failed to connect</h2>
          <p className="text-xs text-muted-foreground max-w-sm">{config.configError}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={config.retryConfig}
        >
          <RefreshCw className="size-3" />
          Retry
        </Button>
      </div>
    )
  }

  if (!config.claudeDir) {
    return <SetupScreen onConfigured={config.setClaudeDir} />
  }

  // ─── Shared elements ──────────────────────────────────────────────────────

  // SSE connection indicator (shows when session loaded but SSE disconnected)
  const sseIndicator = state.session && state.sessionSource && sseState === "disconnected" && (
    <div role="status" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-amber-900/50 bg-elevation-3 px-3 py-2 depth-high toast-enter">
      <WifiOff className="size-3.5 text-amber-400" />
      <span className="text-xs text-amber-400">Live connection lost</span>
      <span className="text-[10px] text-muted-foreground">Reconnecting automatically...</span>
    </div>
  )

  // Error toast
  const errorToast = activeError && (
    <div role="alert" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-red-900/50 bg-elevation-3 px-3 py-2 depth-high max-w-md toast-enter">
      <AlertTriangle className="size-3.5 text-red-400 shrink-0" />
      <span className="text-xs text-red-400 flex-1">{activeError}</span>
      {clearActiveError && (
        <button onClick={clearActiveError} className="text-muted-foreground hover:text-foreground shrink-0" aria-label="Dismiss error">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
  const undoConfirmDialog = (
    <UndoConfirmDialog
      state={undoRedo.confirmState}
      isApplying={undoRedo.isApplying}
      applyError={undoRedo.applyError}
      onConfirm={undoRedo.confirmApply}
      onCancel={undoRedo.confirmCancel}
    />
  )

  const branchModalCurrentTurns = branchModalTurn !== null && state.session
    ? state.session.turns.slice(branchModalTurn)
    : []

  const branchModal = branchModalTurn !== null && branchModalBranches.length > 0 && (
    <BranchModal
      branches={branchModalBranches}
      branchPointTurnIndex={branchModalTurn}
      currentTurns={branchModalCurrentTurns}
      onClose={handleCloseBranchModal}
      onRedoToTurn={handleRedoToTurn}
      onRedoEntireBranch={handleRedoEntireBranch}
    />
  )

  const serverPanelNode = serverPanel.serverMap.size > 0 && (
    <ServerPanel
      servers={serverPanel.serverMap}
      visibleIds={serverPanel.visibleServerIds}
      collapsed={serverPanel.serverPanelCollapsed}
      onToggleServer={serverPanel.handleToggleServer}
      onToggleCollapse={serverPanel.handleToggleServerCollapse}
    />
  )

  const teamMembersBar = teamContext && (
    <TeamMembersBar
      teamName={teamContext.config.name || teamContext.teamName}
      members={teamContext.config.members}
      currentMemberName={state.currentMemberName}
      loadingMember={state.loadingMember}
      onMemberClick={actions.handleTeamMemberSwitch}
      onTeamClick={actions.handleOpenTeamFromBar}
    />
  )

  const chatInputNode = (
    <div className="shrink-0">
      <ChatInput
        ref={chatInputRef}
        status={claudeChat.status}
        error={claudeChat.error}
        isConnected={claudeChat.isConnected}
        onSend={claudeChat.sendMessage}
        onInterrupt={claudeChat.interrupt}
        onStopSession={handleStopSession}
        pendingInteraction={pendingInteraction}
        slashSuggestions={slashSuggestions.suggestions}
        slashSuggestionsLoading={slashSuggestions.loading}
        expandCommand={slashSuggestions.expandCommand}
      />
    </div>
  )

  // ─── MOBILE LAYOUT ──────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className={`${themeCtx.themeClasses} flex h-dvh flex-col bg-elevation-0 text-foreground`}>
        <main className="flex flex-1 min-h-0 overflow-hidden">
          {state.mobileTab === "sessions" && (
            <SessionBrowser
              session={state.session}
              activeSessionKey={activeSessionKey}
              onLoadSession={actions.handleLoadSession}
              sidebarTab={state.sidebarTab}
              onSidebarTabChange={handleSidebarTabChange}
              onSelectTeam={actions.handleSelectTeam}
              onNewSession={handleNewSession}
              creatingSession={creatingSession}
              onDuplicateSession={handleDuplicateSessionByPath}
              onDeleteSession={handleDeleteSession}
              isMobile
            />
          )}

          {state.mobileTab === "chat" && (
            <div className="flex flex-1 min-h-0 flex-col min-w-0">
              {state.mainView === "teams" && state.selectedTeam ? (
                <TeamsDashboard
                  teamName={state.selectedTeam}
                  onBack={actions.handleBackFromTeam}
                  onOpenSession={actions.handleOpenSessionFromTeam}
                />
              ) : state.session ? (
                <div className="flex flex-1 min-h-0 flex-col">
                  {teamMembersBar}
                  <SessionInfoBar
                    session={state.session}
                    sessionSource={state.sessionSource}
                    creatingSession={creatingSession}
                    isMobile
                    dispatch={dispatch}
                    onNewSession={handleNewSession}
                    onDuplicateSession={handleDuplicateSession}
                    onOpenTerminal={handleOpenTerminal}
                    onBackToMain={isSubAgentView ? handleBackToMain : undefined}
                  />
                  <ChatArea
                    session={state.session}
                    activeTurnIndex={state.activeTurnIndex}
                    activeToolCallId={state.activeToolCallId}
                    searchQuery={state.searchQuery}
                    expandAll={state.expandAll}
                    isMobile
                    isSubAgentView={isSubAgentView}
                    dispatch={dispatch}
                    searchInputRef={searchInputRef}
                    chatScrollRef={scroll.chatScrollRef}
                    scrollEndRef={scroll.scrollEndRef}
                    canScrollUp={scroll.canScrollUp}
                    canScrollDown={scroll.canScrollDown}
                    handleScroll={scroll.handleScroll}
                    undoRedo={undoRedo}
                    onOpenBranches={handleOpenBranches}
                    onBranchFromHere={handleBranchFromHere}
                    pendingMessage={claudeChat.pendingMessage}
                    isConnected={claudeChat.isConnected}
                    onToggleExpandAll={handleToggleExpandAll}
                  />
                </div>
              ) : state.pendingDirName ? (
                <div className="flex flex-1 min-h-0 flex-col">
                  {claudeChat.pendingMessage ? (
                    <div className="flex-1 overflow-y-auto px-1 py-3">
                      <PendingTurnPreview
                        message={claudeChat.pendingMessage}
                        turnNumber={1}
                        statusText="Creating session..."
                      />
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center gap-1">
                      <p className="text-sm text-muted-foreground">New session — type your first message below</p>
                      <p className="text-xs text-muted-foreground font-mono">{shortPath(pendingPath ?? "")}</p>
                      <div className="flex items-center gap-1 mt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/20"
                          onClick={handleOpenTerminal}
                        >
                          <TerminalSquare className="size-3" />
                          Terminal
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <Dashboard
                  onSelectSession={actions.handleDashboardSelect}
                  onNewSession={handleNewSession}
                  creatingSession={creatingSession}
                  selectedProjectDirName={state.dashboardProject}
                  onSelectProject={handleSelectProject}
                  onDuplicateSession={handleDuplicateSessionByPath}
                  onDeleteSession={handleDeleteSession}
                />
              )}
            </div>
          )}

          {state.mobileTab === "stats" && state.session && (
            <StatsPanel
              session={state.session}
              onJumpToTurn={handleMobileJumpToTurn}
              onToggleServer={serverPanel.handleToggleServer}
              onServersChanged={serverPanel.handleServersChanged}
              isMobile
              permissionsPanel={permissionsPanelNode}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              hasSettingsChanges={hasSettingsChanges}
              onApplySettings={handleApplySettings}
              onLoadSession={handleLoadSessionScrollAware}
              sessionSource={state.sessionSource}
              backgroundAgents={backgroundAgents}
            />
          )}

          {state.mobileTab === "stats" && state.pendingDirName && !state.session && (
            <SessionSetupPanel
              permissionsPanel={permissionsPanelNode}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              worktreeEnabled={worktreeEnabled}
              onWorktreeEnabledChange={setWorktreeEnabled}
              worktreeName={newSessionWorktreeName}
              onWorktreeNameChange={setNewSessionWorktreeName}
            />
          )}

          {state.mobileTab === "teams" && (
            <div className="flex flex-1 min-h-0 flex-col min-w-0">
              {state.selectedTeam ? (
                <TeamsDashboard
                  teamName={state.selectedTeam}
                  onBack={actions.handleBackFromTeam}
                  onOpenSession={actions.handleOpenSessionFromTeam}
                />
              ) : (
                <SessionBrowser
                  session={state.session}
                  activeSessionKey={activeSessionKey}
                  onLoadSession={actions.handleLoadSession}
                  sidebarTab="teams"
                  onSidebarTabChange={handleSidebarTabChange}
                  onSelectTeam={actions.handleSelectTeam}
                  isMobile
                  teamsOnly
                />
              )}
            </div>
          )}
        </main>

        {serverPanelNode}
        {state.mobileTab === "chat" && (state.session || state.pendingDirName) && state.mainView !== "teams" && (
          <>
            {todoProgress && <TodoProgressPanel progress={todoProgress} />}
            {subAgentReadOnlyNode || chatInputNode}
          </>
        )}

        <MobileNav
          activeTab={state.mobileTab}
          onTabChange={actions.handleMobileTabChange}
          hasSession={!!state.session || !!state.pendingDirName}
          hasTeam={!!teamContext}
          isLive={isLive}
        />

        {undoConfirmDialog}
        {branchModal}
        {errorToast || sseIndicator}
      </div>
    )
  }

  // ─── DESKTOP LAYOUT ─────────────────────────────────────────────────────────
  return (
    <div className={`${themeCtx.themeClasses} flex h-dvh flex-col bg-elevation-0 text-foreground`}>
      <DesktopHeader
        session={state.session}
        isLive={isLive}
        showSidebar={showSidebar}
        showStats={showStats}
        showWorktrees={showWorktrees}
        killing={killing}
        networkUrl={config.networkUrl}
        networkAccessDisabled={config.networkAccessDisabled}
        onGoHome={actions.handleGoHome}
        onToggleSidebar={handleToggleSidebar}
        onToggleStats={handleToggleStats}
        onToggleWorktrees={handleToggleWorktrees}
        onKillAll={handleKillAll}
        onOpenSettings={config.openConfigDialog}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {showSidebar && (
          <SessionBrowser
            session={state.session}
            activeSessionKey={activeSessionKey}
            onLoadSession={actions.handleLoadSession}
            sidebarTab={state.sidebarTab}
            onSidebarTabChange={handleSidebarTabChange}
            onSelectTeam={actions.handleSelectTeam}
            onNewSession={handleNewSession}
            creatingSession={creatingSession}
            onDuplicateSession={handleDuplicateSessionByPath}
            onDeleteSession={handleDeleteSession}
          />
        )}

        <main className="relative flex-1 min-w-0 overflow-hidden flex flex-col">
          {state.mainView === "teams" && state.selectedTeam ? (
            <TeamsDashboard
              teamName={state.selectedTeam}
              onBack={actions.handleBackFromTeam}
              onOpenSession={actions.handleOpenSessionFromTeam}
            />
          ) : state.session ? (
            <div className="flex flex-1 min-h-0 flex-col">
              {teamMembersBar}
              <SessionInfoBar
                session={state.session}
                sessionSource={state.sessionSource}
                creatingSession={creatingSession}
                isMobile={false}
                dispatch={dispatch}
                onNewSession={handleNewSession}
                onDuplicateSession={handleDuplicateSession}
                onOpenTerminal={handleOpenTerminal}
                onBackToMain={isSubAgentView ? handleBackToMain : undefined}
              />

              <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
                <ResizablePanel defaultSize={hasFileChanges ? 50 : 100} minSize="500px">
                  <ChatArea
                    session={state.session}
                    activeTurnIndex={state.activeTurnIndex}
                    activeToolCallId={state.activeToolCallId}
                    searchQuery={state.searchQuery}
                    expandAll={state.expandAll}
                    isMobile={false}
                    isSubAgentView={isSubAgentView}
                    dispatch={dispatch}
                    searchInputRef={searchInputRef}
                    chatScrollRef={scroll.chatScrollRef}
                    scrollEndRef={scroll.scrollEndRef}
                    canScrollUp={scroll.canScrollUp}
                    canScrollDown={scroll.canScrollDown}
                    handleScroll={scroll.handleScroll}
                    undoRedo={undoRedo}
                    onOpenBranches={handleOpenBranches}
                    onBranchFromHere={handleBranchFromHere}
                    pendingMessage={claudeChat.pendingMessage}
                    isConnected={claudeChat.isConnected}
                    onToggleExpandAll={handleToggleExpandAll}
                  />
                </ResizablePanel>

                {hasFileChanges && (
                  <>
                    <ResizableHandle withHandle />
                    <ResizablePanel defaultSize={50} minSize={0} collapsible>
                      <FileChangesPanel session={state.session} sessionChangeKey={state.sessionChangeKey} />
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>

              {todoProgress && <TodoProgressPanel progress={todoProgress} />}
              {subAgentReadOnlyNode || chatInputNode}
            </div>
          ) : state.pendingDirName ? (
            <div className="flex flex-1 min-h-0">
              <div className="flex flex-1 min-h-0 flex-col min-w-0">
                {claudeChat.pendingMessage ? (
                  <div className="flex-1 overflow-y-auto px-4 py-6">
                    <div className="mx-auto max-w-4xl">
                      <PendingTurnPreview
                        message={claudeChat.pendingMessage}
                        turnNumber={1}
                        statusText="Creating session..."
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center gap-1">
                    <p className="text-sm text-muted-foreground">New session — type your first message below</p>
                    <p className="text-xs text-muted-foreground font-mono">{shortPath(pendingPath ?? "")}</p>
                    <div className="flex items-center gap-1 mt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/20"
                        onClick={handleOpenTerminal}
                      >
                        <TerminalSquare className="size-3" />
                        Terminal
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-blue-400 hover:bg-blue-500/20"
                        onClick={() => authFetch("/api/open-in-editor", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ path: pendingPath ?? "" }),
                        }).catch(() => {})}
                      >
                        <Code2 className="size-3" />
                        Open
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 gap-1.5 text-[11px] text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10"
                        onClick={() => authFetch("/api/reveal-in-folder", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ path: pendingPath ?? "" }),
                        }).catch(() => {})}
                      >
                        <FolderSearch className="size-3" />
                        Reveal
                      </Button>
                    </div>
                  </div>
                )}
                {chatInputNode}
              </div>
              <SessionSetupPanel
                permissionsPanel={permissionsPanelNode}
                selectedModel={selectedModel}
                onModelChange={setSelectedModel}
                worktreeEnabled={worktreeEnabled}
                onWorktreeEnabledChange={setWorktreeEnabled}
                worktreeName={newSessionWorktreeName}
                onWorktreeNameChange={setNewSessionWorktreeName}
              />
            </div>
          ) : (
            <Dashboard
              onSelectSession={actions.handleDashboardSelect}
              onNewSession={handleNewSession}
              creatingSession={creatingSession}
              selectedProjectDirName={state.dashboardProject}
              onSelectProject={handleSelectProject}
              onDuplicateSession={handleDuplicateSessionByPath}
              onDeleteSession={handleDeleteSession}
            />
          )}
        </main>

        {showStats && state.session && state.mainView !== "teams" && (
          <StatsPanel
            session={state.session}
            onJumpToTurn={actions.handleJumpToTurn}
            onToggleServer={serverPanel.handleToggleServer}
            onServersChanged={serverPanel.handleServersChanged}
            searchQuery={state.searchQuery}
            onSearchChange={handleSearchChange}
            expandAll={state.expandAll}
            onToggleExpandAll={handleToggleExpandAll}
            searchInputRef={searchInputRef}
            permissionsPanel={permissionsPanelNode}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
            hasSettingsChanges={hasSettingsChanges}
            onApplySettings={handleApplySettings}
            onLoadSession={handleLoadSessionScrollAware}
            sessionSource={state.sessionSource}
            backgroundAgents={backgroundAgents}
          />
        )}

      </div>

      <WorktreePanel
        open={showWorktrees}
        onOpenChange={setShowWorktrees}
        worktrees={worktreeData.worktrees}
        loading={worktreeData.loading}
        dirName={currentDirName}
        onRefetch={worktreeData.refetch}
        onOpenSession={(sessionId) => {
          // sessionId is a JSONL filename without extension; navigate to it
          if (currentDirName) {
            actions.handleDashboardSelect(currentDirName, `${sessionId}.jsonl`)
          }
          setShowWorktrees(false)
        }}
      />

      {serverPanelNode}
      {undoConfirmDialog}
      {branchModal}

      <ConfigDialog
        open={config.showConfigDialog}
        currentPath={config.claudeDir ?? ""}
        onClose={config.handleCloseConfigDialog}
        onSaved={(newPath: string) => {
          config.handleConfigSaved(newPath)
        }}
      />

      <ProjectSwitcherModal
        open={showProjectSwitcher}
        onClose={handleCloseProjectSwitcher}
        onNewSession={handleNewSession}
        currentProjectDirName={state.sessionSource?.dirName ?? state.pendingDirName ?? null}
      />

      <ThemeSelectorModal
        open={showThemeSelector}
        onClose={handleCloseThemeSelector}
        currentTheme={themeCtx.theme}
        onSelectTheme={themeCtx.setTheme}
        onPreviewTheme={themeCtx.setPreview}
      />

      {errorToast || sseIndicator}
    </div>
  )
}
