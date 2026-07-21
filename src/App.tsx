import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, startTransition, lazy, Suspense } from "react"
import { Loader2, AlertTriangle, RefreshCw, WifiOff, X, Bot } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AgentContextBar } from "@/components/AgentContextBar"
import { ChatInputSettings } from "@/components/ChatInput/ChatInputSettings"
import { TeamMembersBar } from "@/components/TeamMembersBar"
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput"
import { GoalBar } from "@/components/GoalBar"
import { ProcessPanel } from "@/components/ProcessPanel"
import { BackgroundServers } from "@/components/stats/BackgroundServers"
import { UndoConfirmDialog } from "@/components/UndoConfirmDialog"
import { SetupScreen } from "@/components/SetupScreen"
import { PendingTurnPreview } from "@/components/PendingTurnPreview"
import { TodoProgressPanel } from "@/components/TodoProgressPanel"
import { DesktopAppShell } from "@/components/AppShell/DesktopAppShell"
import { MobileAppShell } from "@/components/AppShell/MobileAppShell"
import { useLiveSession } from "@/hooks/useLiveSession"
import { useSessionTeam } from "@/hooks/useSessionTeam"
import { useSessionWorkflows } from "@/hooks/useSessionWorkflows"
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
import { usePermissionRequests } from "@/hooks/usePermissionRequests"
import { useUndoRedo } from "@/hooks/useUndoRedo"
import { useAppConfig } from "@/hooks/useAppConfig"
import { useWorktrees } from "@/hooks/useWorktrees"
import { useKillAll } from "@/hooks/useKillAll"
import { useMcpServers } from "@/hooks/useMcpServers"
import { useTodoProgress } from "@/hooks/useTodoProgress"
import { useBackgroundAgents } from "@/hooks/useBackgroundAgents"
import { useSlashSuggestions } from "@/hooks/useSlashSuggestions"
import { usePanelState } from "@/hooks/usePanelState"
import { useAppHandlers } from "@/hooks/useAppHandlers"
import { useParserWorker } from "@/hooks/useParserWorker"
import { useChunkedSession } from "@/hooks/useChunkedSession"
import { useComposerSettings } from "@/hooks/useComposerSettings"
import { useProjectWorkspace } from "@/hooks/useProjectWorkspace"
import { useProjectSessionLaunch } from "@/hooks/useProjectSessionLaunch"
import { prefetchSession as prefetchSessionFn } from "@/lib/sessionPrefetch"
import { detectPendingInteraction } from "@/lib/parser"
import { dirNameToPath, parseSubAgentPath } from "@/lib/format"
import { OPEN_SUBAGENT_EVENT } from "@/components/FileChangesPanel/file-change-indicators"
import { FOCUS_FILE_EVENT } from "@/components/FileChangesPanel"
import type { ParsedSession, Turn } from "@/lib/types"
import { authFetch } from "@/lib/auth"
import {
  agentKindFromDirName,
} from "@/lib/sessionSource"
import { LoginScreen } from "@/components/LoginScreen"
import { useNetworkAuth } from "@/hooks/useNetworkAuth"
import type { PanelSize } from "react-resizable-panels"
import { AppProvider } from "@/contexts/AppContext"
import { SessionProvider, type SessionContextValue, type SessionChatContextValue } from "@/contexts/SessionContext"
import { StreamingOverlayProvider } from "@/contexts/StreamingOverlayContext"
import { PtyProvider } from "@/contexts/PtyContext"

// Lazy-loaded components (only rendered when user opens them)
const BranchModal = lazy(() => import("@/components/BranchModal").then(m => ({ default: m.BranchModal })))
const WorkflowsPanel = lazy(() => import("@/components/WorkflowsPanel").then(m => ({ default: m.WorkflowsPanel })))

export default function App() {
  const config = useAppConfig()
  const networkAuth = useNetworkAuth()
  const isMobile = useIsMobile()
  const themeCtx = useTheme()
  const [state, dispatch] = useSessionState()
  const { parse: workerParse, append: workerAppend } = useParserWorker()

  const handlePrependTurns = useCallback((olderTurns: Turn[], _hasMore: boolean, _nextByteOffset: number) => {
    dispatch({ type: "PREPEND_TURNS", turns: olderTurns })
  }, [dispatch])

  // Stable prefetch callback bound to the current worker. Used by sidebar rows
  // to warm the LRU cache on hover-intent so a subsequent click is synchronous.
  const prefetchSession = useCallback(
    (dirName: string, fileName: string) => {
      void prefetchSessionFn(dirName, fileName, workerParse)
    },
    [workerParse],
  )

  const chunkedSession = useChunkedSession({
    dirName: state.sessionSource?.dirName ?? null,
    fileName: state.sessionSource?.fileName ?? null,
    workerParse,
    onPrependTurns: handlePrependTurns,
  })

  // Panel/sidebar toggle state
  const panels = usePanelState(state, dispatch)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const chatInputRef = useRef<ChatInputHandle>(null)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false)
  // Stable callbacks
  const handleSidebarTabChange = useCallback(
    (tab: "live" | "browse" | "teams") => dispatch({ type: "SET_SIDEBAR_TAB", tab }),
    [dispatch]
  )
  const handleToggleExpandAll = useCallback(() => dispatch({ type: "TOGGLE_EXPAND_ALL" }), [dispatch])
  const handleOpenCommandPalette = useCallback(() => setShowCommandPalette(true), [])
  const handleFocusComposer = useCallback(() => chatInputRef.current?.focus(), [])
  const handleExpandAll = useCallback(() => dispatch({ type: "SET_EXPAND_ALL", value: true }), [dispatch])
  const handleCollapseAll = useCallback(() => dispatch({ type: "SET_EXPAND_ALL", value: false }), [dispatch])
  const handleSelectProject = useCallback((dirName: string | null) => dispatch({ type: "SET_DASHBOARD_PROJECT", dirName }), [dispatch])

  // Real filesystem path for the pending (pre-created) session.
  // pendingCwd is the authoritative path; dirNameToPath is a lossy fallback.
  const pendingPath = state.pendingCwd ?? (state.pendingDirName ? dirNameToPath(state.pendingDirName) : null)
  const currentAgentKind = state.sessionSource?.agentKind
    ?? agentKindFromDirName(state.sessionSource?.dirName ?? state.pendingDirName ?? null)
  const supportsWorktrees = currentAgentKind === "claude"
  const supportsMcp = currentAgentKind === "claude"
  const slashSuggestions = useSlashSuggestions(state.session?.cwd ?? pendingPath ?? undefined)

  const handleEditCommand = useCallback((commandName: string) => {
    const match = slashSuggestions.suggestions.find((s) => s.name === commandName)
    dispatch({ type: "OPEN_CONFIG", filePath: match?.filePath })
  }, [dispatch, slashSuggestions.suggestions])

  const handleExpandCommand = useCallback(async (commandName: string, args?: string): Promise<string | null> => {
    const match = slashSuggestions.suggestions.find((s) => s.name === commandName)
    if (!match?.filePath) return null
    try {
      const res = await authFetch("/api/expand-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: match.filePath, args: args || "" }),
      })
      if (!res.ok) return null
      const data = await res.json()
      return data.content ?? null
    } catch {
      return null
    }
  }, [slashSuggestions.suggestions])

  // Project-scoped process panel, terminal/editor actions, and right workspace.
  const {
    processPanel,
    currentCwd,
    showPreview,
    showProjectFiles,
    launchTerminalRequest,
    postProjectAction,
    handleOpenTerminal,
    handleMcpAuth,
    handleToggleIntegratedTerminal,
    handleNewIntegratedTerminal,
    handleTogglePreview,
    handleToggleProjectFiles,
    closeRightWorkspace,
  } = useProjectWorkspace({
    sessionId: state.session?.sessionId,
    sessionCwd: state.session?.cwd,
    pendingPath,
    sessionDirName: state.sessionSource?.dirName,
    pendingDirName: state.pendingDirName,
    dashboardProject: state.dashboardProject,
  })

  // TODO progress from session's TodoWrite tool calls
  const todoProgress = useTodoProgress(state.session ?? null)
  const [todosExpanded, setTodosExpanded] = useState(false)

  // Derive the current project dirName from session, pending session, or dashboard selection
  const currentDirName = state.sessionSource?.dirName ?? state.pendingDirName ?? state.dashboardProject ?? null

  // Worktree data — only fetched when panel is open
  const worktreeData = useWorktrees(supportsWorktrees && panels.showWorktrees ? currentDirName : null)

  // Check if session has any Edit/Write tool calls for the file changes panel
  const hasFileChanges = useMemo(() => {
    if (!state.session) return false
    return state.session.turns.some((turn) =>
      turn.toolCalls.some((tc) => tc.name === "Edit" || tc.name === "Write")
    )
  }, [state.session])

  // Cheaply detect workflow runs from already-parsed turns (Workflow tool calls).
  // Drives the trigger button and gates the per-session workflow fetch/watch so
  // we never open an fs.watch on sessions that never launched a workflow.
  const workflowToolCallCount = useMemo(() => {
    if (!state.session) return 0
    let n = 0
    for (const turn of state.session.turns)
      for (const tc of turn.toolCalls)
        if (tc.name === "Workflow") n++
    return n
  }, [state.session])
  const hasWorkflowToolCalls = workflowToolCallCount > 0

  // Workflows live under the top-level session dir; not shown on sub-agent views.
  const workflowSource = useMemo(() => {
    const src = state.sessionSource
    if (!src || parseSubAgentPath(src.fileName)) {
      return { dirName: null as string | null, sessionId: null as string | null }
    }
    return { dirName: src.dirName, sessionId: src.fileName.replace(/\.jsonl$/, "") }
  }, [state.sessionSource])

  const sessionWorkflows = useSessionWorkflows(
    workflowSource.dirName,
    workflowSource.sessionId,
    hasWorkflowToolCalls,
  )
  const workflowBadgeCount = sessionWorkflows.workflows.length || workflowToolCallCount
  const setShowWorkflows = panels.setShowWorkflows
  const handleShowWorkflows = useCallback(() => setShowWorkflows(true), [setShowWorkflows])

  // Track whether the file changes panel has been collapsed via drag
  const [fileChangesCollapsed, setFileChangesCollapsed] = useState(false)
  const handleFileChangesPanelResize = useCallback((size: PanelSize) => {
    setFileChangesCollapsed(size.asPercentage === 0)
  }, [])

  // Mobile file changes bottom sheet
  const [showMobileFileChanges, setShowMobileFileChanges] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)

  // Force-show file changes panel when a file is clicked in TurnChangedFiles
  const setShowFileChanges = panels.setShowFileChanges
  useEffect(() => {
    const handler = () => {
      if (isMobile) {
        setShowMobileFileChanges(true)
      } else {
        setShowFileChanges(true)
        setFileChangesCollapsed(false)
      }
    }
    window.addEventListener(FOCUS_FILE_EVENT, handler)
    return () => window.removeEventListener(FOCUS_FILE_EVENT, handler)
  }, [setShowFileChanges, isMobile])

  // Detect pending interactive prompts (plan approval, user questions)
  const pendingInteraction = useMemo(
    () => state.session ? detectPendingInteraction(state.session) : null,
    [state.session],
  )

  // Live session streaming — wrapped in startTransition so React can
  // interrupt these low-priority renders to process user interactions (clicks).
  // On reconnect after disconnect, reload the full session to catch missed messages.
  // state.session is passed as `initialSession` so the hook can skip the
  // duplicate worker parse on every source change (the session was already
  // parsed by useSessionActions / useNewSession before dispatch).
  const reconnectHandlerRef = useRef<(() => void) | null>(null)
  const { isLive, sseState, isCompacting, streamingOverlay } = useLiveSession(
    state.sessionSource,
    (updated) => {
      startTransition(() => {
        dispatch({ type: "UPDATE_SESSION", session: updated })
      })
    },
    workerParse,
    workerAppend,
    () => reconnectHandlerRef.current?.(),
    state.session,
  )

  // Background agents (shared between notifications + StatsPanel)
  const backgroundAgents = useBackgroundAgents(state.session?.cwd ?? null)

  // Permissions management
  const perms = usePermissions()

  // Permission requests — SDK resolves canUseTool in-place, no retry needed
  const permReqs = usePermissionRequests(state.session?.sessionId ?? null, perms.config.mode)

  const {
    selectedModel,
    setSelectedModel,
    setSelectedEffort,
    effectiveEffort,
    fastModeAvailable,
    fastModeActive,
    setFastModeEnabled,
    ultracodeAvailable,
    ultracodeActive,
    setUltracodeEnabled,
    imageInputAvailable,
    modelFallbackNotice,
    dismissModelFallbackNotice,
    handleCodexModelRejected,
  } = useComposerSettings({
    agentKind: currentAgentKind,
    session: state.session,
    sessionSource: state.sessionSource,
    pendingDirName: state.pendingDirName,
    isLive,
  })

  // MCP server selection
  const mcpData = useMcpServers(
    supportsMcp ? currentCwd : undefined,
    supportsMcp ? (currentDirName ?? undefined) : undefined,
    supportsMcp ? state.sessionSource?.fileName ?? undefined : undefined
  )
  const { showWorktrees, setShowWorktrees, showWorkflows } = panels

  useEffect(() => {
    if (!supportsWorktrees && showWorktrees) {
      setShowWorktrees(false)
    }
  }, [supportsWorktrees, showWorktrees, setShowWorktrees])

  // Close the workflows panel when navigating to a session without workflows.
  useEffect(() => {
    if (showWorkflows && !hasWorkflowToolCalls) {
      setShowWorkflows(false)
    }
  }, [showWorkflows, hasWorkflowToolCalls, setShowWorkflows])

  // New-session launch is lazy: the backend is not called until first submit.
  const {
    creatingSession,
    createError,
    clearCreateError,
    createAndSend,
    cancelCreation,
    worktreeEnabled,
    setWorktreeEnabled,
    sessionFinalizedRef,
    liveSessionsRefreshRef,
    pendingSessionInfo,
    pendingAgentKindChange,
    handleStartNewSession,
    handleStartNewFolder,
  } = useProjectSessionLaunch({
    permissionsConfig: perms.config,
    dispatch,
    isMobile,
    defaultAgentKind: config.defaultAgentKind,
    pendingDirName: state.pendingDirName,
    pendingCwd: state.pendingCwd,
    onCodexModelRejected: handleCodexModelRejected,
    model: selectedModel,
    effort: effectiveEffort,
    fastMode: fastModeActive,
    ultracode: ultracodeActive,
    mcpConfig: supportsMcp ? mcpData.mcpConfigJson : null,
  })

  // Active agent chat
  const claudeChat = usePtyChat({
    sessionSource: state.sessionSource,
    parsedSessionId: state.session?.sessionId ?? null,
    cwd: state.session?.cwd,
    permissions: perms.config,
    onPermissionsApplied: perms.markApplied,
    model: selectedModel,
    effort: effectiveEffort,
    fastMode: fastModeActive,
    ultracode: ultracodeActive,
    mcpConfig: supportsMcp ? mcpData.mcpConfigJson : null,
    onCodexModelRejected: handleCodexModelRejected,
    onCreateSession: state.pendingDirName ? createAndSend : undefined,
  })

  // Detect if session belongs to a team
  const teamContext = useSessionTeam(
    state.sessionSource?.fileName ?? null,
    state.sessionSource?.dirName ?? null
  )

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
    pendingMessages: claudeChat.pendingMessages,
    consumePending: claudeChat.consumePending,
    sessionChangeKey: state.sessionChangeKey,
  })

  const chatScrollRef = scroll.chatScrollRef
  const resetFinalizedSessionTurnCount = scroll.resetTurnCount
  const scrollFinalizedSessionToBottom = scroll.scrollToBottomInstant

  const handleTodosExpandedChange = useCallback((expanded: boolean) => {
    setTodosExpanded(expanded)
    // Scroll chat to compensate for padding change (pb-48 vs pb-32 = 64px)
    requestAnimationFrame(() => {
      const el = chatScrollRef.current
      if (el) {
        el.scrollTo({ top: el.scrollTop + (expanded ? 64 : -64), behavior: "smooth" })
      }
    })
  }, [chatScrollRef])

  // Wire up the session-finalized bridge now that scroll is available. A layout
  // effect keeps render pure and installs the latest callback before user input
  // or passive effects can finalize a newly-created session.
  useLayoutEffect(() => {
    const handleSessionFinalized = (_parsed: ParsedSession) => {
      // Reset to 0 so useChatScroll detects "new turns" and clears pendingMessage
      resetFinalizedSessionTurnCount(0)
      scrollFinalizedSessionToBottom()
    }
    sessionFinalizedRef.current = handleSessionFinalized
    return () => {
      if (sessionFinalizedRef.current === handleSessionFinalized) {
        sessionFinalizedRef.current = null
      }
    }
  }, [resetFinalizedSessionTurnCount, scrollFinalizedSessionToBottom, sessionFinalizedRef])

  // Pre-session-switch cleanup: abort in-flight send-message and session creation
  // requests to free HTTP connections before fetching the new session data.
  const handlePreSessionSwitch = useCallback(() => {
    claudeChat.disconnect()
    cancelCreation()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeChat.disconnect, cancelCreation])

  // Session action handlers
  const actions = useSessionActions({
    dispatch,
    isMobile,
    teamContext,
    scrollToBottomInstant: scroll.scrollToBottomInstant,
    resetTurnCount: scroll.resetTurnCount,
    workerParse,
    onBeforeSwitch: handlePreSessionSwitch,
  })

  const goHome = actions.handleGoHome
  const handleOpenPaletteProject = useCallback((dirName: string) => {
    goHome()
    handleSelectProject(dirName)
  }, [goHome, handleSelectProject])

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
  const pushHistory = sessionHistory.push
  useEffect(() => {
    if (state.sessionSource) {
      pushHistory(state.sessionSource.dirName, state.sessionSource.fileName)
    }
  }, [state.sessionSource, pushHistory])

  // App-level handlers (extracted from App.tsx)
  const handlers = useAppHandlers({
    state: { session: state.session, sessionSource: state.sessionSource },
    dispatch,
    isMobile,
    handleJumpToTurn: actions.handleJumpToTurn,
    markPermissionsApplied: perms.markApplied,
    hasPermsPendingChanges: perms.hasPendingChanges,
    permissionsConfig: perms.config,
    selectedModel,
    setSelectedModel,
    selectedEffort: effectiveEffort,
    setSelectedEffort,
    fastMode: fastModeActive,
    setFastMode: setFastModeEnabled,
    ultracode: ultracodeActive,
    setUltracode: setUltracodeEnabled,
    mcpConfig: supportsMcp ? mcpData.mcpConfigJson : null,
    scrollRequestScrollToTop: scroll.requestScrollToTop,
    handleDashboardSelect: actions.handleDashboardSelect,
  })

  // Auto-apply MCP settings ONLY when data first loads (loaded: false→true).
  // This handles the race condition where a session starts before MCP data is
  // available, so it launches without restrictions. Once data arrives, we restart.
  // We intentionally do NOT auto-apply when switching between sessions or when
  // the user changes MCP selection — those require explicit "Apply Settings".
  const { hasSettingsChanges, handleApplySettings } = handlers
  const mcpHasRestrictions = supportsMcp && mcpData.mcpConfigJson !== null
  const mcpPrevLoadedRef = useRef(false)
  useEffect(() => {
    const justLoaded = mcpData.loaded && !mcpPrevLoadedRef.current
    mcpPrevLoadedRef.current = mcpData.loaded
    const sessionId = state.session?.sessionId
    if (justLoaded && sessionId && mcpHasRestrictions && hasSettingsChanges) {
      handleApplySettings()
    }
  }, [mcpData.loaded, mcpHasRestrictions, hasSettingsChanges, handleApplySettings, state.session?.sessionId])

  // Wire the reconnect bridge after reloadSession is available. Layout timing
  // guarantees useLiveSession's passive EventSource effect observes the latest
  // committed handler, without leaking a discarded render through the ref.
  useLayoutEffect(() => {
    reconnectHandlerRef.current = handlers.reloadSession
    return () => {
      if (reconnectHandlerRef.current === handlers.reloadSession) {
        reconnectHandlerRef.current = null
      }
    }
  }, [handlers.reloadSession])

  // Undo/redo system
  const undoRedo = useUndoRedo(state.session, state.sessionSource, handlers.reloadSession)

  // Wire up branch switch now that undoRedo is available
  // We need to re-create handlers that depend on undoRedo.requestBranchSwitch
  const requestBranchSwitch = undoRedo.requestBranchSwitch
  const setBranchModalTurn = handlers.setBranchModalTurn
  const handleRedoToTurn = useCallback((branchId: string, archiveTurnIdx: number) => {
    requestBranchSwitch(branchId, archiveTurnIdx)
    setBranchModalTurn(null)
  }, [requestBranchSwitch, setBranchModalTurn])
  const handleRedoEntireBranch = useCallback((branchId: string) => {
    requestBranchSwitch(branchId)
    setBranchModalTurn(null)
  }, [requestBranchSwitch, setBranchModalTurn])

  // Keyboard shortcuts
  useKeyboardShortcuts({
    isMobile,
    searchInputRef,
    chatInputRef,
    dispatch,
    onToggleSidebar: panels.handleToggleSidebar,
    onToggleRightSidebar: panels.handleToggleStats,
    onOpenCommandPalette: handleOpenCommandPalette,
    onOpenProjectSwitcher: panels.handleOpenProjectSwitcher,
    onOpenThemeSelector: panels.handleToggleThemeSelector,
    onOpenTerminal: handleOpenTerminal,
    onToggleIntegratedTerminal: handleToggleIntegratedTerminal,
    onTogglePreview: handleTogglePreview,
    onToggleProjectFiles: handleToggleProjectFiles,
    onHistoryBack: sessionHistory.goBack,
    onHistoryForward: sessionHistory.goForward,
    onNavigateToSession: actions.handleDashboardSelect,
    onCommitNavigation: sessionHistory.commitNavigation,
  })

  // Kill-all handler
  const { killing, handleKillAll } = useKillAll()

  // Navigate back to parent session when viewing a sub-agent
  // Team members also live under subagents/ but are NOT read-only subagent views —
  // they should get the normal chat input so users can send prompts directly.
  const subAgentInfo = state.sessionSource ? parseSubAgentPath(state.sessionSource.fileName) : null
  const isTeamMemberView = subAgentInfo !== null && !!teamContext?.currentMemberName
  const isSubAgentView = subAgentInfo !== null && !isTeamMemberView

  const navigateToSession = actions.handleDashboardSelect
  const handleBackToMain = useCallback(() => {
    if (!state.sessionSource || !subAgentInfo) return
    navigateToSession(state.sessionSource.dirName, subAgentInfo.parentFileName)
  }, [state.sessionSource, subAgentInfo, navigateToSession])

  // Navigate to a sub-agent's session when clicking the "S" indicator
  useEffect(() => {
    const handler = (e: Event) => {
      const { agentId } = (e as CustomEvent<{ agentId: string }>).detail ?? {}
      if (!agentId || !state.sessionSource) return
      // Derive the parent session ID: if already viewing a sub-agent, use its parentSessionId;
      // otherwise strip .jsonl from the current fileName.
      const parentId = subAgentInfo
        ? subAgentInfo.parentSessionId
        : state.sessionSource.fileName.replace(/\.jsonl$/, "")
      navigateToSession(state.sessionSource.dirName, `${parentId}/subagents/agent-${agentId}.jsonl`)
    }
    window.addEventListener(OPEN_SUBAGENT_EVENT, handler)
    return () => window.removeEventListener(OPEN_SUBAGENT_EVENT, handler)
  }, [state.sessionSource, subAgentInfo, navigateToSession])

  const branchModalBranches = handlers.branchModalTurn !== null ? undoRedo.branchesAtTurn(handlers.branchModalTurn) : []

  // Read-only banner shown when viewing a sub-agent session (replaces chat input)
  const subAgentReadOnlyNode = isSubAgentView ? (
    <div className="shrink-0 flex items-center justify-center gap-2 border-t border-border/50 bg-elevation-1 px-4 py-2.5">
      <Bot className="size-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">Viewing sub-agent session (read-only)</span>
    </div>
  ) : null

  // Collect all error messages for toast display — first non-null wins
  const activeError = actions.loadError || createError || null
  let clearActiveError: (() => void) | undefined
  if (actions.loadError) clearActiveError = actions.clearLoadError
  else if (createError) clearActiveError = clearCreateError

  // Auto-dismiss error toasts after 8 seconds
  useEffect(() => {
    if (!activeError || !clearActiveError) return
    const timer = setTimeout(clearActiveError, 8000)
    return () => clearTimeout(timer)
  }, [activeError, clearActiveError])

  // ─── Build context values ──────────────────────────────────────────────────

  // Fine-grained deps: re-create context only when fields that AppContext
  // consumers actually use change.  state.session / state.sessionSource are
  // deliberately excluded — consumers get session data from SessionContext.
  // This prevents the entire component tree from re-rendering on every SSE
  // update during streaming (~60 Hz), which previously starved the main
  // thread and made buttons unclickable.
  const appContextValue = useMemo(() => ({
    state,
    dispatch,
    config,
    theme: themeCtx,
    networkAuth,
    isMobile,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [
    state.activeTurnIndex, state.activeToolCallId,
    state.searchQuery, state.expandAll,
    state.mainView, state.mobileTab, state.sidebarTab,
    state.dashboardProject, state.pendingDirName, state.pendingCwd,
    state.currentMemberName, state.loadingMember,
    state.selectedTeam, state.configFilePath, state.sessionChangeKey,
    dispatch, config, themeCtx, networkAuth, isMobile,
  ])

  // Stable context — session data, undo/redo, actions. Does NOT include chat/scroll
  // so timeline components don't re-render when chat status or scroll indicators change.
  const sessionContextValue = useMemo<SessionContextValue>(() => ({
    session: state.session,
    sessionSource: state.sessionSource,
    isLive,
    sseState,
    isCompacting,
    undoRedo,
    pendingInteraction,
    permissionRequests: permReqs.requests,
    permissionResponding: permReqs.responding,
    respondPermission: permReqs.respond,
    respondAllPermissions: permReqs.respondAll,
    isSubAgentView,
    slashSuggestions: slashSuggestions.suggestions,
    slashSuggestionsLoading: slashSuggestions.loading,
    actions: {
      handleStopSession: handlers.handleStopSession,
      handleEditConfig: panels.handleEditConfig,
      handleEditCommand,
      handleExpandCommand,
      handleOpenBranches: handlers.handleOpenBranches,
      handleBranchFromHere: handlers.handleBranchFromHere,
      handleToggleExpandAll,
      handleLoadSession: handlers.handleLoadSessionScrollAware,
    },
  }), [
    state.session, state.sessionSource,
    isLive, sseState, isCompacting,
    undoRedo, pendingInteraction, isSubAgentView,
    permReqs.requests, permReqs.responding, permReqs.respond, permReqs.respondAll,
    slashSuggestions.suggestions, slashSuggestions.loading,
    handlers.handleStopSession, panels.handleEditConfig, handleEditCommand, handleExpandCommand,
    handlers.handleOpenBranches, handlers.handleBranchFromHere, handleToggleExpandAll,
    handlers.handleLoadSessionScrollAware,
  ])

  // Volatile context — chat status + scroll indicators. Only consumed by ChatArea,
  // ChatInput, and InputToolbar. Changes here don't touch TurnSection or the timeline.
  const sessionChatValue = useMemo<SessionChatContextValue>(() => ({
    chat: {
      status: claudeChat.status,
      error: claudeChat.error,
      pendingMessages: claudeChat.pendingMessages,
      isConnected: claudeChat.isConnected,
      sendMessage: claudeChat.sendMessage,
      interrupt: claudeChat.interrupt,
      stopAgent: claudeChat.stopAgent,
      consumePending: claudeChat.consumePending,
    },
    scroll,
  }), [
    claudeChat.status, claudeChat.error, claudeChat.pendingMessages, claudeChat.isConnected,
    claudeChat.sendMessage, claudeChat.interrupt, claudeChat.stopAgent, claudeChat.consumePending,
    scroll,
  ])

  // ─── AUTH GATE (remote clients only) ────────────────────────────────────────
  if (!networkAuth.authChecked) {
    return (
      <div
        className="dark flex h-dvh items-center justify-center bg-elevation-0"
        role="status"
        aria-label="Checking authentication"
      >
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

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
    <div role="status" title="Connection lost — reconnecting..." className="fixed bottom-3 left-1/2 -translate-x-1/2 z-50 rounded-full border border-amber-900/50 bg-elevation-3 p-1.5 depth-high toast-enter">
      <WifiOff className="size-3 text-amber-400" />
    </div>
  )

  // Error toast
  const errorToast = activeError && (
    <div role="alert" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-red-900/50 bg-elevation-3 px-3 py-2 depth-high max-w-md toast-enter">
      <AlertTriangle className="size-3.5 text-red-400 shrink-0" />
      <span className="text-xs text-red-400 flex-1">{activeError}</span>
      {clearActiveError && (
        <button type="button" onClick={clearActiveError} className="text-muted-foreground hover:text-foreground shrink-0" aria-label="Dismiss error">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
  const modelFallbackToast = modelFallbackNotice && (
    <div role="status" className="fixed bottom-4 left-1/2 z-50 flex max-w-md -translate-x-1/2 items-center gap-2 rounded-lg border border-amber-900/50 bg-elevation-3 px-3 py-2 depth-high toast-enter">
      <AlertTriangle className="size-3.5 shrink-0 text-amber-400" />
      <span className="flex-1 text-xs text-amber-300">{modelFallbackNotice}</span>
      <button type="button" onClick={dismissModelFallbackNotice} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label="Dismiss model notice">
        <X className="size-3.5" />
      </button>
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

  const branchModalCurrentTurns = handlers.branchModalTurn !== null && state.session
    ? state.session.turns.slice(handlers.branchModalTurn)
    : []

  const branchModal = handlers.branchModalTurn !== null && branchModalBranches.length > 0 && (
    <Suspense fallback={null}>
      <BranchModal
        branches={branchModalBranches}
        branchPointTurnIndex={handlers.branchModalTurn}
        currentTurns={branchModalCurrentTurns}
        onClose={handlers.handleCloseBranchModal}
        onRedoToTurn={handleRedoToTurn}
        onRedoEntireBranch={handleRedoEntireBranch}
      />
    </Suspense>
  )

  const processPanelNode = processPanel.processes.size > 0 && (
    <ProcessPanel
      processes={processPanel.processes}
      activeProcessId={processPanel.activeProcessId}
      collapsed={processPanel.collapsed}
      onSetActive={processPanel.setActive}
      onRemove={processPanel.removeProcess}
      onToggleCollapse={processPanel.toggleCollapse}
      onRequestTerminal={handleNewIntegratedTerminal}
      onAddTerminalContext={(selection) => {
        const value = selection.trim()
        if (!value) return
        const fence = value.includes("```") ? "````" : "```"
        const context = `${fence}terminal\n${value}\n${fence}`
        const current = chatInputRef.current?.getText().trimEnd() ?? ""
        chatInputRef.current?.setText(current ? `${current}\n\n${context}\n` : `${context}\n`)
        chatInputRef.current?.focus()
      }}
      onUpdateStatus={processPanel.updateProcessStatus}
      mobile={isMobile}
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

  // Keep delegated Claude agents visible in the session context, even when
  // the optional Stats panel is closed. The detailed timeline and Stats panel
  // remain the places for full transcripts and metrics.
  const agentContextBar = state.session && !isSubAgentView && (
    <AgentContextBar
      session={state.session}
      sessionSource={state.sessionSource}
      backgroundAgents={backgroundAgents}
      onLoadSession={handlers.handleLoadSessionScrollAware}
      mobile={isMobile}
    />
  )

  // Workflow visualization panel — mounted only for sessions that ran a
  // workflow, so its chunk loads lazily and the Sheet can animate open/close.
  const workflowsPanelNode = hasWorkflowToolCalls && (
    <Suspense fallback={null}>
      <WorkflowsPanel
        open={panels.showWorkflows}
        onOpenChange={panels.setShowWorkflows}
        dirName={workflowSource.dirName}
        sessionId={workflowSource.sessionId}
        workflows={sessionWorkflows.workflows}
        isLive={sessionWorkflows.isLive}
        onRefetchList={sessionWorkflows.refetch}
      />
    </Suspense>
  )

  const isNewSession = !!state.pendingDirName && !state.session

  const goalBarNode = currentAgentKind && state.session ? (
    <GoalBar
      agentKind={currentAgentKind}
      session={state.session}
      onSendCommand={claudeChat.sendMessage}
    />
  ) : null

  const chatInputSettingsNode = (
    <ChatInputSettings
      agentKind={currentAgentKind ?? "claude"}
      onAgentKindChange={isNewSession ? pendingAgentKindChange : undefined}
      selectedModel={selectedModel}
      onModelChange={setSelectedModel}
      selectedEffort={effectiveEffort}
      onEffortChange={setSelectedEffort}
      fastModeEnabled={fastModeActive}
      onFastModeEnabledChange={fastModeAvailable ? setFastModeEnabled : undefined}
      isNewSession={isNewSession}
      worktreeEnabled={worktreeEnabled}
      onWorktreeEnabledChange={isNewSession && supportsWorktrees ? setWorktreeEnabled : undefined}
      ultracodeEnabled={ultracodeActive}
      onUltracodeEnabledChange={ultracodeAvailable ? setUltracodeEnabled : undefined}
      onApplySettings={handlers.handleApplySettings}
      activeModelId={state.session?.model}
      mcpServers={supportsMcp ? mcpData.servers : undefined}
      selectedMcpServers={supportsMcp ? mcpData.selectedServers : undefined}
      onToggleMcpServer={supportsMcp ? mcpData.toggleServer : undefined}
      onRefreshMcpServers={supportsMcp ? mcpData.refresh : undefined}
      mcpLoading={supportsMcp ? mcpData.loading : undefined}
      onMcpAuth={supportsMcp ? handleMcpAuth : undefined}
      permissionMode={perms.config.mode}
      onPermissionModeChange={perms.setMode}
      mobileExtra={isMobile ? goalBarNode : undefined}
      mobile={isMobile}
    />
  )

  const chatInputNode = (
    <div className="shrink-0 bg-elevation-1">
      {!isMobile && goalBarNode}
      <ChatInput
        ref={chatInputRef}
        allowImages={imageInputAvailable}
        agentKind={currentAgentKind}
        projectCwd={currentCwd}
        compact={isMobile}
        leadingAccessory={isMobile ? chatInputSettingsNode : undefined}
      />
      {!isMobile && chatInputSettingsNode}
    </div>
  )

  const pendingPreviewList = claudeChat.pendingMessages.map((msg, i) => (
    <PendingTurnPreview
      key={i}
      message={msg}
      turnNumber={i + 1}
    />
  ))

  // Server discovery when StatsPanel is hidden — StatsPanel has its own BackgroundServers instance
  const statsPanelVisible = isMobile ? state.mobileTab === "stats" : panels.showStats
  const backgroundServers = state.session && !statsPanelVisible && (
    <div className="hidden">
      <BackgroundServers
        cwd={state.session.cwd}
        turns={state.session.turns}
        onServersChanged={processPanel.handleServersChanged}
      />
    </div>
  )

  // ─── MOBILE LAYOUT ──────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <AppProvider value={appContextValue}>
      <PtyProvider>
      <SessionProvider value={sessionContextValue} chatValue={sessionChatValue}>
      <StreamingOverlayProvider value={streamingOverlay}>
        <MobileAppShell
          navigation={{
            actions,
            handlers,
            creatingSession,
            pendingSession: pendingSessionInfo,
            onSidebarTabChange: handleSidebarTabChange,
            onStartNewSession: handleStartNewSession,
            onSelectProject: handleSelectProject,
            onBeforeSessionSwitch: handlePreSessionSwitch,
            liveSessionsRefreshRef,
            onPrefetchSession: prefetchSession,
          }}
          sessionView={{
            searchInputRef,
            teamMembersBar,
            agentContextBar,
            hasTeam: Boolean(teamContext),
            activeComposer: subAgentReadOnlyNode || chatInputNode,
            pendingComposer: chatInputNode,
            pendingTurns: pendingPreviewList,
            todoProgress: todoProgress && <TodoProgressPanel progress={todoProgress} />,
            hasMoreTurns: chunkedSession.hasMore,
            onLoadMoreTurns: chunkedSession.loadMore,
            onBackToMain: handleBackToMain,
            onShowWorkflows: handleShowWorkflows,
            onToggleExpandAll: handleToggleExpandAll,
            workflowCount: workflowBadgeCount,
            pendingPath,
          }}
          project={{
            processPanel,
            backgroundAgents,
            hasFileChanges,
            onOpenTerminal: handleOpenTerminal,
          }}
          chrome={{
            backgroundServers,
            processPanel: processPanelNode,
            workflowsPanel: workflowsPanelNode,
            undoDialog: undoConfirmDialog,
            branchModal,
            status: errorToast || modelFallbackToast || sseIndicator,
            fileChangesOpen: showMobileFileChanges,
            onFileChangesOpenChange: setShowMobileFileChanges,
            searchOpen: mobileSearchOpen,
            onSearchOpenChange: setMobileSearchOpen,
          }}
        />
      </StreamingOverlayProvider>
      </SessionProvider>
      </PtyProvider>
      </AppProvider>
    )
  }

  // ─── DESKTOP LAYOUT ─────────────────────────────────────────────────────────
  return (
    <AppProvider value={appContextValue}>
    <PtyProvider>
    <SessionProvider value={sessionContextValue} chatValue={sessionChatValue}>
      <StreamingOverlayProvider value={streamingOverlay}>
        <DesktopAppShell
          navigation={{
            panels,
            actions,
            handlers,
            creatingSession,
            pendingSession: pendingSessionInfo,
            onSidebarTabChange: handleSidebarTabChange,
            onStartNewSession: handleStartNewSession,
            onStartNewFolder: handleStartNewFolder,
            onSelectProject: handleSelectProject,
            onOpenPaletteProject: handleOpenPaletteProject,
            onBeforeSessionSwitch: handlePreSessionSwitch,
            liveSessionsRefreshRef,
            onPrefetchSession: prefetchSession,
          }}
          sessionView={{
            searchInputRef,
            chatInputRef,
            teamMembersBar,
            agentContextBar,
            activeComposer: subAgentReadOnlyNode || chatInputNode,
            pendingComposer: chatInputNode,
            pendingTurns: pendingPreviewList,
            todoProgress,
            todosExpanded,
            onTodosExpandedChange: handleTodosExpandedChange,
            hasMoreTurns: chunkedSession.hasMore,
            onLoadMoreTurns: chunkedSession.loadMore,
            onBackToMain: handleBackToMain,
            onShowWorkflows: handleShowWorkflows,
            workflowCount: workflowBadgeCount,
            fileChangesCollapsed,
            onFileChangesPanelResize: handleFileChangesPanelResize,
          }}
          project={{
            processPanel,
            worktrees: worktreeData,
            backgroundAgents,
            supportsWorktrees,
            hasFileChanges,
            currentCwd,
            showPreview,
            showProjectFiles,
            launchTerminalRequest,
            onOpenTerminal: handleOpenTerminal,
            onTogglePreview: handleTogglePreview,
            onToggleProjectFiles: handleToggleProjectFiles,
            onCloseRightWorkspace: closeRightWorkspace,
            onPostProjectAction: postProjectAction,
          }}
          chrome={{
            backgroundServers,
            processPanel: processPanelNode,
            workflowsPanel: workflowsPanelNode,
            undoDialog: undoConfirmDialog,
            branchModal,
            status: errorToast || modelFallbackToast || sseIndicator,
            killing,
            onKillAll: handleKillAll,
            commandPaletteOpen: showCommandPalette,
            onCommandPaletteOpenChange: setShowCommandPalette,
            onOpenCommandPalette: handleOpenCommandPalette,
            onFocusComposer: handleFocusComposer,
            onExpandAll: handleExpandAll,
            onCollapseAll: handleCollapseAll,
            keyboardShortcutsOpen: showKeyboardShortcuts,
            onKeyboardShortcutsOpenChange: setShowKeyboardShortcuts,
          }}
        />
      </StreamingOverlayProvider>
      </SessionProvider>
    </PtyProvider>
    </AppProvider>
  )
}
