import { ConversationComposer } from "@/components/ConversationComposer"
import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, lazy, Suspense, type ReactNode } from "react"
import { Loader2, AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { AppStatusToasts } from "@/components/AppStatusToasts"
import { ChatInputSettings } from "@/components/ChatInput/ChatInputSettings"
import { TeamMembersBar } from "@/components/TeamMembersBar"
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput"
import { GoalProvider, GoalSection, GoalTrigger } from "@/components/goal"
import { DelegatedRequests } from "@/components/DelegatedRequests"
import { cn } from "@/lib/utils"
import { ProcessPanel } from "@/components/ProcessPanel"
import { OpenSessionBackgroundServers } from "@/components/stats/BackgroundServers"
import { UndoConfirmDialog } from "@/components/UndoConfirmDialog"
import { SetupScreen } from "@/components/SetupScreen"
import { QueuedTurns } from "@/components/QueuedTurns"
import { TodoProgressPanel } from "@/components/TodoProgressPanel"
import { DesktopAppShell } from "@/components/AppShell/DesktopAppShell"
import { MobileAppShell } from "@/components/AppShell/MobileAppShell"
import { PreviewAppShell } from "@/components/AppShell/PreviewAppShell"
import { useLiveSession } from "@/hooks/useLiveSession"
import { useSessionTeam } from "@/hooks/useSessionTeam"
import { useSessionWorkflows } from "@/hooks/useSessionWorkflows"
import { usePtyChat } from "@/hooks/usePtyChat"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useSessionSelector, useSessionState } from "@/hooks/useSessionState"
import { useSessionActions } from "@/hooks/useSessionActions"
import { useSessionController } from "@/hooks/useSessionController"
import { useUrlSync } from "@/hooks/useUrlSync"
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts"
import { useTheme } from "@/hooks/useTheme"
import { useSessionHistory } from "@/hooks/useSessionHistory"
import { useSessionAccessLoss } from "@/hooks/useSessionAccessLoss"
import { usePermissions } from "@/hooks/usePermissions"
import type { PermissionMode } from "@/lib/permissions"
import { usePermissionRequests } from "@/hooks/usePermissionRequests"
import { useUndoRedo } from "@/hooks/useUndoRedo"
import { useAppConfig } from "@/hooks/useAppConfig"
import { useMe } from "@/hooks/useMe"
import { useWorktrees } from "@/hooks/useWorktrees"
import { useKillAll } from "@/hooks/useKillAll"
import { useMcpServers } from "@/hooks/useMcpServers"
import { useTodoProgress } from "@/hooks/useTodoProgress"
import { useBackgroundAgents } from "@/hooks/useBackgroundAgents"
import { useSlashSuggestions } from "@/hooks/useSlashSuggestions"
import { usePanelState } from "@/hooks/usePanelState"
import { useAppHandlers } from "@/hooks/useAppHandlers"
import { useParserWorker } from "@/hooks/useParserWorker"
import { useSessionPaging } from "@/hooks/useSessionPaging"
import { useComposerSettings } from "@/hooks/useComposerSettings"
import { useSessionConfigSync } from "@/hooks/useSessionConfigSync"
import type { SessionConfig } from "@/lib/sessionConfig"
import { useProjectWorkspace } from "@/hooks/useProjectWorkspace"
import { useProjectSessionLaunch } from "@/hooks/useProjectSessionLaunch"
import { detectPendingInteraction } from "../shared/session/parser"
import { dirNameToPath, parseSubAgentPath } from "@/lib/format"
import { OPEN_SUBAGENT_EVENT } from "@/components/FileChangesPanel/file-change-indicators"
import { FOCUS_FILE_EVENT } from "@/components/FileChangesPanel"
import { previewSessionIdFromPath } from "@/lib/previewMode"
import type { Turn } from "../shared/session/types"
import type { SessionView } from "../shared/session/sessionDigest"
import { sameModelFallback, samePendingInteraction } from "@/lib/sessionFacts"
import { newContextId, type ComposerAttachment, type ComposerContextItem } from "../shared/session/composerContext"
import { useQuoteNavigation } from "@/hooks/useQuoteNavigation"
import { turnsChangeFiles, workflowCallCount } from "@/lib/turnFacts"
import { authFetch } from "@/lib/auth"
import { getSessionConfigKey } from "@/lib/sessionConfig"
import { can } from "@/lib/capabilities"
import {
  agentKindForDirName,
  capabilitiesFor,
  rootSessionIdOf,
  sessionIdFromFileName,
} from "@/lib/agents"
import { LoginScreen } from "@/components/LoginScreen"
import { useNetworkAuth } from "@/hooks/useNetworkAuth"
import { DefaultGateScreen } from "@/edition/DefaultGateScreen"
import { EditionUiFailedScreen } from "@/edition/EditionUiFailedScreen"
import { useEditionUi } from "@/edition/hooks"
import { useEditionUiReadiness } from "@/edition/load"
import { AppProvider } from "@/contexts/AppContext"
import { OpenSessionProvider, type ChatState, type ScrollState, type SessionControls } from "@/contexts/SessionContext"
import { useSessionInventory } from "@/contexts/SessionInventoryContext"
import { StreamingOverlayProvider } from "@/contexts/StreamingOverlayContext"
import { PtyProvider } from "@/contexts/PtyContext"
import { isExternallyDrivenSession } from "@/lib/sessionControl"
import { permissionsForAccess } from "@/lib/sessionAccessPermissions"
import { useSessionAccess } from "@/hooks/useSessionAccess"
import { accessReadOnlyReason, SessionReadOnlyNotice, type ReadOnlyReason } from "@/components/SessionReadOnlyNotice"
import { BUILT_IN_WORKSPACE_PANEL_IDS } from "@/plugins/builtInPanelIds"

// Lazy-loaded components (only rendered when user opens them)
const BranchModal = lazy(() => import("@/components/BranchModal").then(m => ({ default: m.BranchModal })))
const WorkflowsPanel = lazy(() => import("@/components/WorkflowsPanel").then(m => ({ default: m.WorkflowsPanel })))

// Facts App reads from the open session, at module scope so each runs only when the session changes.
const selectSessionId = (open: SessionView | null) => open?.sessionId ?? null
const selectCwd = (open: SessionView | null) => open?.cwd
const selectModel = (open: SessionView | null) => open?.model
const selectHasSession = (open: SessionView | null) => open !== null
const selectChangesFiles = (open: SessionView | null) => open ? turnsChangeFiles(open.turns, open.cwd) : false
const selectInteraction = (open: SessionView | null) => open ? detectPendingInteraction(open) : null
const selectModelFallback = (open: SessionView | null) => open?.digest.modelFallback ?? null

/** A fresh load brings back everything the server refused while its gate kept the caller out. */
function reloadApp(): void {
  window.location.reload()
}

export default function App() {
  const previewSessionId = previewSessionIdFromPath(window.location.pathname)
  const config = useAppConfig()
  const networkAuth = useNetworkAuth()
  const me = useMe(networkAuth.edition)
  const editionLoad = useEditionUiReadiness(networkAuth.edition, me.edition)
  const editionUi = useEditionUi()
  const identityReady = me.checked && (me.edition === "personal" || me.user !== null)
  const configAdminEnabled = identityReady && me.capabilities.configWrite
  const hostFilesEnabled = identityReady && me.capabilities.hostFiles
  const terminalEnabled = identityReady && me.capabilities.terminal
  const isMobile = useIsMobile()
  const themeCtx = useTheme()
  // The open session's content lives in `sessionStore`. App reads only the
  // facts it needs from it, so a streamed batch does not re-render the shell.
  const [state, dispatchState, sessionStore] = useSessionState()
  const getSession = useCallback(() => sessionStore.getState().session, [sessionStore])
  const sessionId = useSessionSelector(sessionStore, selectSessionId)
  const sessionCwd = useSessionSelector(sessionStore, selectCwd)
  const sessionModel = useSessionSelector(sessionStore, selectModel)
  const hasSession = useSessionSelector(sessionStore, selectHasSession)
  const { procBySession } = useSessionInventory()
  const { parse: workerParse, parsePage, append: workerAppend } = useParserWorker()
  const { sessions, dispatch } = useSessionController(dispatchState, workerParse)

  const handleOlderTurns = useCallback((olderTurns: Turn[]) => {
    dispatch({ type: "SET_OLDER_TURNS", turns: olderTurns })
  }, [dispatch])

  // Stable prefetch callback bound to the current worker. Used by sidebar rows
  // to warm the LRU cache on hover-intent so a subsequent click is synchronous.
  const prefetchSession = useCallback(
    (dirName: string, fileName: string) => sessions.prefetchSession({ dirName, fileName }),
    [sessions],
  )

  const chunkedSession = useSessionPaging({
    dirName: state.sessionSource?.dirName ?? null,
    fileName: state.sessionSource?.fileName ?? null,
    sessionChangeKey: state.sessionChangeKey,
    workerParse: parsePage,
    onOlderTurns: handleOlderTurns,
  })

  // While in-session search is active, hydrate the full transcript in the
  // background: sessions open bottom-first (tail only), so without this a
  // search would silently miss turns that haven't been scroll-loaded yet.
  // Each loadMore prepends a chunk → re-render → this effect re-fires until
  // the cache reports no more chunks.
  const { loadMore: loadMoreTurns } = chunkedSession
  const searchHydrationActive = Boolean(state.searchQuery) && chunkedSession.hasMore
  const loadedTurnCount = useSessionSelector(
    sessionStore,
    useCallback((open: SessionView | null) => searchHydrationActive ? open?.turns.length ?? 0 : 0, [searchHydrationActive]),
  )
  useEffect(() => {
    if (!searchHydrationActive) return
    void loadMoreTurns()
  }, [searchHydrationActive, loadMoreTurns, loadedTurnCount])

  // Panel/sidebar toggle state
  const panels = usePanelState(state, dispatch)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const chatInputRef = useRef<ChatInputHandle>(null)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false)
  // Stable callbacks
  const handleToggleExpandAll = useCallback(() => dispatch({ type: "TOGGLE_EXPAND_ALL" }), [dispatch])
  const handleOpenCommandPalette = useCallback(() => setShowCommandPalette(true), [])
  const handleFocusComposer = useCallback(() => chatInputRef.current?.focus(), [])
  const handleExpandAll = useCallback(() => dispatch({ type: "SET_EXPAND_ALL", value: true }), [dispatch])
  const handleExpandToolPayloads = useCallback(() => dispatch({ type: "SET_EXPAND_TOOL_PAYLOADS", value: true }), [dispatch])
  const handleCollapseAll = useCallback(() => dispatch({ type: "SET_EXPAND_ALL", value: false }), [dispatch])
  const toggleWorkspacePanel = panels.toggleWorkspacePanel
  const handleToggleSessionInfo = useCallback(
    () => toggleWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo),
    [toggleWorkspacePanel],
  )
  const handleSelectProject = useCallback((dirName: string | null) => {
    dispatch({ type: "SET_DASHBOARD_PROJECT", dirName })
  }, [dispatch])

  // Real filesystem path for the pending (pre-created) session.
  // pendingCwd is the authoritative path; dirNameToPath is a lossy fallback.
  const pendingPath = state.pendingCwd ?? (state.pendingDirName ? dirNameToPath(state.pendingDirName) : null)
  const currentAgentKind = state.sessionSource?.agentKind
    ?? agentKindForDirName(state.sessionSource?.dirName ?? state.pendingDirName ?? null)
  const currentProcess = sessionId ? procBySession.get(sessionId) : undefined
  const agentCapabilities = capabilitiesFor(currentAgentKind)
  const isReadOnlySession = isExternallyDrivenSession(currentAgentKind, currentProcess)
  const sessionAccess = useSessionAccess(sessionId)
  const sessionPermissions = permissionsForAccess(sessionAccess.level)
  const supportsWorktrees = agentCapabilities.worktrees
  const mcpEnabled = agentCapabilities.mcp && configAdminEnabled && sessionPermissions.mcp
  const slashSuggestions = useSlashSuggestions(
    configAdminEnabled ? sessionCwd ?? pendingPath ?? undefined : undefined,
    configAdminEnabled && agentCapabilities.slashCommands,
  )

  const handleEditCommand = useCallback((commandName: string) => {
    if (!configAdminEnabled) return
    const match = slashSuggestions.suggestions.find((s) => s.name === commandName)
    dispatch({ type: "OPEN_CONFIG", filePath: match?.filePath })
  }, [configAdminEnabled, dispatch, slashSuggestions.suggestions])

  const handleExpandCommand = useCallback(async (commandName: string, args?: string): Promise<string | null> => {
    if (!configAdminEnabled) return null
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
  }, [configAdminEnabled, slashSuggestions.suggestions])

  // Project-scoped process panel, terminal/editor actions, and right workspace.
  const openWorkspacePanel = panels.openWorkspacePanel
  const openProjectWorkspacePanel = useCallback((panelId: string) => {
    openWorkspacePanel(panelId)
    if (isMobile) dispatch({ type: "SET_MOBILE_TAB", tab: "workspace" })
  }, [openWorkspacePanel, isMobile, dispatch])
  const openCrewPanel = useCallback(
    () => openProjectWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.crew),
    [openProjectWorkspacePanel],
  )
  const crewPanelOpen = panels.activeWorkspacePanel === BUILT_IN_WORKSPACE_PANEL_IDS.crew
    && (!isMobile || state.mobileTab === "workspace")

  const {
    processPanel,
    currentCwd,
    showPreview,
    showProjectFiles,
    projectFilesRoot,
    projectFilesRequest,
    launchTerminalRequest,
    pendingProject,
    handleOpenTerminal,
    handleMcpAuth,
    handleToggleIntegratedTerminal,
    handleNewIntegratedTerminal,
    handleTogglePreview,
    handleToggleProjectFiles,
    closeRightWorkspace,
  } = useProjectWorkspace({
    sessionId: sessionId ?? undefined,
    sessionCwd,
    pendingPath,
    sessionDirName: state.sessionSource?.dirName,
    pendingDirName: state.pendingDirName,
    dashboardProject: state.dashboardProject,
    supportsFileWorkspace: hostFilesEnabled,
    activeWorkspacePanel: panels.activeWorkspacePanel,
    openWorkspacePanel: openProjectWorkspacePanel,
    closeWorkspacePanel: panels.closeWorkspacePanel,
  })

  // TODO progress from session's TodoWrite tool calls
  const todoProgress = useTodoProgress(sessionStore)
  const [todosExpanded, setTodosExpanded] = useState(false)

  // Derive the current project dirName from session, pending session, or dashboard selection
  const currentDirName = state.sessionSource?.dirName ?? state.pendingDirName ?? state.dashboardProject ?? null
  const { activeWorkspacePanel, closeWorkspacePanel, showWorkflows } = panels

  // Worktree data is only fetched while its workspace panel is visible.
  const worktreeData = useWorktrees(
    identityReady
      && supportsWorktrees
      && state.mainView === "sessions"
      && activeWorkspacePanel === BUILT_IN_WORKSPACE_PANEL_IDS.worktrees
      ? currentDirName
      : null,
  )

  // Does the session change files at all? Covers Edit/Write, MultiEdit, and the
  // Bash writes that bypass-permissions sessions produce instead.
  const hasFileChanges = useSessionSelector(sessionStore, selectChangesFiles)

  // Cheaply detect workflow runs from already-parsed turns (Workflow tool calls).
  // Drives the trigger button and gates the per-session workflow fetch/watch so
  // we never open an fs.watch on sessions that never launched a workflow.
  const tracksWorkflows = agentCapabilities.workflows
  const workflowToolCallCount = useSessionSelector(
    sessionStore,
    useCallback((open: SessionView | null) => open && tracksWorkflows ? workflowCallCount(open.turns) : 0, [tracksWorkflows]),
  )
  const hasWorkflowToolCalls = workflowToolCallCount > 0

  // Workflows live under the top-level session dir; not shown on sub-agent views.
  const workflowSource = useMemo(() => {
    const src = state.sessionSource
    if (!src || !agentCapabilities.workflows || parseSubAgentPath(src.fileName)) {
      return { dirName: null as string | null, sessionId: null as string | null }
    }
    return { dirName: src.dirName, sessionId: sessionIdFromFileName(src.fileName) }
  }, [state.sessionSource, agentCapabilities.workflows])

  const sessionWorkflows = useSessionWorkflows(
    workflowSource.dirName,
    workflowSource.sessionId,
    hasWorkflowToolCalls,
  )
  const hasWorkflows = hasWorkflowToolCalls || sessionWorkflows.workflows.length > 0
  const workflowBadgeCount = sessionWorkflows.workflows.length || workflowToolCallCount
  const setShowWorkflows = panels.setShowWorkflows
  const handleShowWorkflows = useCallback(() => setShowWorkflows(true), [setShowWorkflows])

  // Mobile file changes bottom sheet
  const [showMobileFileChanges, setShowMobileFileChanges] = useState(false)

  // Force-show file changes panel when a file is clicked in TurnChangedFiles
  useEffect(() => {
    if (!hostFilesEnabled) return
    const handler = () => {
      if (isMobile) {
        setShowMobileFileChanges(true)
      } else {
        openWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges)
      }
    }
    window.addEventListener(FOCUS_FILE_EVENT, handler)
    return () => window.removeEventListener(FOCUS_FILE_EVENT, handler)
  }, [hostFilesEnabled, openWorkspacePanel, isMobile])

  const transcriptInteraction = useSessionSelector(sessionStore, selectInteraction, samePendingInteraction)

  // The stream starts from the session the open controller already parsed, so
  // the worker does not parse it twice. After a reconnect or a failed parse,
  // the session reloads to catch missed messages.
  const handleLiveUpdate = useCallback((session: SessionView, loadId: number) => {
    dispatch({ type: "UPDATE_SESSION", session, loadId })
  }, [dispatch])
  const {
    isLive, sseState, isCompacting, streamingOverlayStore, sessionShown, turnError, agentProgress, promptSuggestion, rateLimit,
  } = useLiveSession(
    state.sessionSource,
    handleLiveUpdate,
    workerParse,
    workerAppend,
    sessions.reloadCurrent,
    getSession,
  )

  // Background agents (shared between notifications + StatsPanel)
  const backgroundAgents = useBackgroundAgents(sessionCwd ?? null)

  // Permissions management
  const perms = usePermissions(currentAgentKind, config.freshInstall)
  const permsSetMode = perms.setMode

  // Permission requests — SDK resolves canUseTool in-place, no retry needed
  const permReqs = usePermissionRequests(
    isReadOnlySession ? null : sessionId,
  )
  const pendingInteraction = isReadOnlySession
    ? null
    : permReqs.plan ?? transcriptInteraction

  const {
    contextWindowTokens,
    setContextWindowTokens,
    contextWindowAvailable,
    selectedModel,
    setSelectedModel,
    selectedEffort,
    setSelectedEffort,
    fastModeEnabled,
    ultracodeEnabled,
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
    handleModelRejected,
  } = useComposerSettings({
    agentKind: currentAgentKind,
    sessionModel,
    modelFallback: useSessionSelector(sessionStore, selectModelFallback, sameModelFallback),
    sessionSource: state.sessionSource,
    pendingDirName: state.pendingDirName,
    isLive,
  })

  // Session-specific config shared across all Cogpit clients: hydrate the
  // composer controls from the server-side store, read it again whenever it may
  // have changed elsewhere, and persist the user's changes back so other
  // devices/browsers see the same state.
  const sessionConfigKey = getSessionConfigKey(
    sessionId ?? undefined,
    state.sessionSource?.fileName,
  )
  const sessionConfig = useSessionConfigSync({
    sessionKey: sessionConfigKey,
    sessionId,
    access: sessionAccess.level,
    values: {
      model: selectedModel,
      effort: selectedEffort,
      contextWindowTokens,
      fastMode: fastModeEnabled,
      ultracode: ultracodeEnabled,
      permissionMode: perms.config.mode,
    },
    onHydrate: useCallback((config: SessionConfig) => {
      setContextWindowTokens(config.contextWindowTokens ?? null)
      if (config.model !== undefined) setSelectedModel(config.model)
      if (config.effort !== undefined) setSelectedEffort(config.effort)
      if (config.fastMode !== undefined) setFastModeEnabled(config.fastMode)
      if (config.ultracode !== undefined) setUltracodeEnabled(config.ultracode)
      if (config.permissionMode) permsSetMode(config.permissionMode)
    }, [setContextWindowTokens, setSelectedModel, setSelectedEffort, setFastModeEnabled, setUltracodeEnabled, permsSetMode]),
  })
  // A session keeps its own permission mode unless the user picked one here.
  const pickedPermissions = sessionConfig.picked.includes("permissionMode") ? perms.config : undefined

  // MCP server selection
  const mcpData = useMcpServers(
    mcpEnabled ? currentCwd : undefined,
    mcpEnabled ? (currentDirName ?? undefined) : undefined,
    mcpEnabled ? sessionConfigKey ?? undefined : undefined,
    mcpEnabled,
  )
  useEffect(() => {
    if (
      !supportsWorktrees
      && activeWorkspacePanel === BUILT_IN_WORKSPACE_PANEL_IDS.worktrees
    ) {
      closeWorkspacePanel()
    }
  }, [supportsWorktrees, activeWorkspacePanel, closeWorkspacePanel])

  // Close the workflows panel when navigating to a session without workflows.
  useEffect(() => {
    if (showWorkflows && !hasWorkflows) {
      setShowWorkflows(false)
    }
  }, [showWorkflows, hasWorkflows, setShowWorkflows])

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
    sessions,
    isMobile,
    defaultAgentKind: config.defaultAgentKind,
    pendingDirName: state.pendingDirName,
    pendingCwd: state.pendingCwd,
    onModelRejected: handleModelRejected,
    model: selectedModel,
    effort: effectiveEffort,
    contextWindowTokens: contextWindowAvailable ? contextWindowTokens : undefined,
    fastMode: fastModeActive,
    ultracode: ultracodeActive,
    mcpConfig: mcpEnabled ? mcpData.mcpConfigJson : null,
  })

  // Active agent chat
  const agentChat = usePtyChat({
    sessionSource: state.sessionSource,
    parsedSessionId: sessionId,
    cwd: sessionCwd,
    permissions: pickedPermissions,
    onPermissionsApplied: perms.markApplied,
    settingsChange: sessionConfig.picked,
    onSettingsChangeSent: sessionConfig.settlePicked,
    model: selectedModel,
    effort: effectiveEffort,
    contextWindowTokens: contextWindowAvailable ? contextWindowTokens : undefined,
    fastMode: fastModeActive,
    ultracode: ultracodeActive,
    mcpConfig: mcpEnabled ? mcpData.mcpConfigJson : null,
    onModelRejected: handleModelRejected,
    readOnly: isReadOnlySession || !sessionPermissions.send,
    onCreateSession: state.pendingDirName ? createAndSend : undefined,
  })

  // The home composer starts a session with its first message already written.
  // The message waits one render for the pending session to exist, so it goes
  // through the same send path as a message typed into the new session's composer.
  // A first message that could not be sent lands back in the new session's
  // composer, where the user now is, instead of disappearing.
  const [queuedFirstMessage, setQueuedFirstMessage] = useState<{ message: string; images?: Array<{ data: string; mediaType: string }>; settle: (sent: boolean) => void } | null>(null)
  const setPermissionModeFor = perms.setModeFor
  const handleStartNewSessionWith = useCallback(async (dirName: string, cwd: string | undefined, message: string, images?: Array<{ data: string; mediaType: string }>, permissionMode?: PermissionMode) => {
    await handleStartNewSession(dirName, cwd)
    // Access chosen on the home is the new session's: stored only once the
    // session open behind the home is closed, so it never changes that one.
    if (permissionMode) setPermissionModeFor(agentKindForDirName(dirName), permissionMode)
    return new Promise<boolean>((settle) => setQueuedFirstMessage({ message, images, settle }))
  }, [handleStartNewSession, setPermissionModeFor])
  const sendQueuedFirstMessage = agentChat.sendMessage
  useEffect(() => {
    if (!queuedFirstMessage || !state.pendingDirName) return
    setQueuedFirstMessage(null)
    const { message, images, settle } = queuedFirstMessage
    void sendQueuedFirstMessage(message, images).then((sent) => {
      if (!sent && !chatInputRef.current?.getText().trim()) chatInputRef.current?.setText(message)
      settle(sent)
    }, () => settle(false))
  }, [queuedFirstMessage, state.pendingDirName, sendQueuedFirstMessage])
  const newSessionModel = {
    selectedModel,
    onModelChange: setSelectedModel,
    selectedEffort: effectiveEffort,
    onEffortChange: setSelectedEffort,
    permissionModeFor: perms.modeFor,
  }

  // Detect if session belongs to a team
  const teamContext = useSessionTeam(
    agentCapabilities.agentTeams ? state.sessionSource?.fileName ?? null : null,
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

  // Guard: reset mobile-only views when their session context disappears.
  useEffect(() => {
    if (!isMobile) return
    dispatch({
      type: "GUARD_MOBILE_TAB",
      hasSession: hasSession || !!state.pendingDirName,
    })
  }, [hasSession, state.pendingDirName, state.mobileTab, isMobile, dispatch])

  // The transcript's scroll lives with the session provider, which renders on
  // every live batch; the shell drives it through this handle.
  const chatScroll = useRef<ScrollState>(null)
  const scrollToBottomInstant = useCallback(() => chatScroll.current?.scrollToBottomInstant(), [])
  const resetTurnCount = useCallback((count: number) => chatScroll.current?.resetTurnCount(count), [])
  const requestScrollToTop = useCallback(() => chatScroll.current?.requestScrollToTop(), [])

  const handleTodosExpandedChange = useCallback((expanded: boolean) => {
    setTodosExpanded(expanded)
    // Scroll chat to compensate for padding change (pb-48 vs pb-32 = 64px)
    requestAnimationFrame(() => {
      const el = chatScroll.current?.chatScrollRef.current
      if (el) {
        el.scrollTo({ top: el.scrollTop + (expanded ? 64 : -64), behavior: "smooth" })
      }
    })
  }, [])

  // Wire up the session-finalized bridge now that scroll is available. A layout
  // effect keeps render pure and installs the latest callback before user input
  // or passive effects can finalize a newly-created session.
  useLayoutEffect(() => {
    const handleSessionFinalized = (_parsed: SessionView) => {
      // Reset to 0 so useChatScroll detects "new turns" and clears pendingMessage
      resetTurnCount(0)
      scrollToBottomInstant()
    }
    sessionFinalizedRef.current = handleSessionFinalized
    return () => {
      if (sessionFinalizedRef.current === handleSessionFinalized) {
        sessionFinalizedRef.current = null
      }
    }
  }, [resetTurnCount, scrollToBottomInstant, sessionFinalizedRef])

  // Pre-session-switch cleanup: abort in-flight send-message and session creation
  // requests to free HTTP connections before fetching the new session data.
  const handlePreSessionSwitch = useCallback(() => {
    agentChat.disconnect()
    cancelCreation()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentChat.disconnect, cancelCreation])

  // Session action handlers
  const actions = useSessionActions({
    dispatch,
    isMobile,
    mobileTab: state.mobileTab,
    teamContext,
    scrollToBottomInstant,
    resetTurnCount,
    sessions,
    onBeforeSwitch: handlePreSessionSwitch,
  })

  const handleOpenPaletteProject = useCallback((dirName: string) => {
    dispatch({ type: "GO_HOME", isMobile })
    dispatch({ type: "SET_DASHBOARD_PROJECT", dirName })
  }, [dispatch, isMobile])

  // Sync URL <-> state
  const { previewLoadError } = useUrlSync({
    state,
    dispatch,
    isMobile,
    resetTurnCount,
    scrollToBottomInstant,
    sessions,
  })

  // MRU session history for Ctrl+Tab switching
  const sessionHistory = useSessionHistory()

  useSessionAccessLoss({
    openSessionId: (state.sessionSource && rootSessionIdOf(state.sessionSource.dirName, state.sessionSource.fileName))
      ?? sessionId,
    leave: actions.handleCloseSession,
    forgetVisits: sessionHistory.forget,
  })

  // Track session visits for history
  const pushHistory = sessionHistory.push
  useEffect(() => {
    if (state.sessionSource) {
      pushHistory(state.sessionSource.dirName, state.sessionSource.fileName)
    }
  }, [state.sessionSource, pushHistory])

  // App-level handlers (extracted from App.tsx)
  const handlers = useAppHandlers({
    state: { sessionId, sessionSource: state.sessionSource },
    sessionStore,
    dispatch,
    isMobile,
    handleJumpToTurn: actions.handleJumpToTurn,
    markPermissionsApplied: perms.markApplied,
    hasPermsPendingChanges: perms.hasPendingChanges,
    permissionsConfig: pickedPermissions,
    settingsChange: sessionConfig.picked,
    onSettingsChangeSent: sessionConfig.settlePicked,
    selectedModel,
    selectedEffort: effectiveEffort,
    fastMode: fastModeActive,
    ultracode: ultracodeActive,
    mcpConfig: mcpEnabled ? mcpData.mcpConfigJson : null,
    scrollRequestScrollToTop: requestScrollToTop,
    handleDashboardSelect: actions.handleDashboardSelect,
    sessions,
    canInteract: sessionPermissions.canInteract,
  })

  // Auto-apply MCP settings ONLY when data first loads (loaded: false→true).
  // This handles the race condition where a session starts before MCP data is
  // available, so it launches without restrictions. Once data arrives, we restart.
  // We intentionally do NOT auto-apply when switching between sessions or when
  // the user changes MCP selection — those require explicit "Apply Settings".
  const { hasSettingsChanges, handleApplySettings } = handlers
  const mcpHasRestrictions = mcpEnabled && mcpData.mcpConfigJson !== null
  const mcpPrevLoadedRef = useRef(false)
  useEffect(() => {
    const justLoaded = mcpData.loaded && !mcpPrevLoadedRef.current
    mcpPrevLoadedRef.current = mcpData.loaded
    if (justLoaded && sessionId && mcpHasRestrictions && hasSettingsChanges) {
      handleApplySettings()
    }
  }, [mcpData.loaded, mcpHasRestrictions, hasSettingsChanges, handleApplySettings, sessionId])

  // Undo/redo system
  const undoRedo = useUndoRedo(
    sessionStore,
    state.sessionSource,
    sessions.reloadCurrent,
    hostFilesEnabled && sessionPermissions.undo,
  )

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
    onToggleRightSidebar: handleToggleSessionInfo,
    onToggleMissionControl: panels.handleToggleMission,
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
      if (!agentId || !state.sessionSource || !agentCapabilities.subagentTranscripts) return
      // Derive the parent session ID: if already viewing a sub-agent, use its parentSessionId;
      // otherwise strip .jsonl from the current fileName.
      const parentId = subAgentInfo
        ? subAgentInfo.parentSessionId
        : sessionIdFromFileName(state.sessionSource.fileName)
      navigateToSession(state.sessionSource.dirName, `${parentId}/subagents/agent-${agentId}.jsonl`)
    }
    window.addEventListener(OPEN_SUBAGENT_EVENT, handler)
    return () => window.removeEventListener(OPEN_SUBAGENT_EVENT, handler)
  }, [state.sessionSource, subAgentInfo, navigateToSession, agentCapabilities.subagentTranscripts])

  const [retainedBranchModalTurn, setRetainedBranchModalTurn] = useState<number | null>(null)
  const branchModalOpen = handlers.branchModalTurn !== null
  const renderedBranchModalTurn = handlers.branchModalTurn ?? retainedBranchModalTurn

  useEffect(() => {
    if (handlers.branchModalTurn !== null) {
      setRetainedBranchModalTurn(handlers.branchModalTurn)
    }
  }, [handlers.branchModalTurn])

  const branchModalBranches = renderedBranchModalTurn !== null
    ? undoRedo.branchesAtTurn(renderedBranchModalTurn)
    : []
  // Followed live only while the modal is up.
  const branchModalShown = renderedBranchModalTurn !== null
  const branchModalTurns = useSessionSelector(
    sessionStore,
    useCallback((open: SessionView | null) => branchModalShown ? open?.turns ?? null : null, [branchModalShown]),
  )

  // Replaces the composer when the session can be read but not driven.
  let readOnlyReason: ReadOnlyReason | null = null
  if (isSubAgentView) readOnlyReason = { kind: "subagent" }
  else if (isReadOnlySession) readOnlyReason = { kind: "external", agentKind: currentAgentKind }
  else readOnlyReason = accessReadOnlyReason(sessionAccess)
  const activeReadOnlyNode = readOnlyReason && <SessionReadOnlyNotice reason={readOnlyReason} />
  const currentSessionId = sessionId
  const canHandoff = currentSessionId !== null && readOnlyReason === null
    && state.mainView === "sessions" && (!isMobile || state.mobileTab === "chat")
  const [providerHandoffSessionId, setProviderHandoffSessionId] = useState<string | null>(null)
  useEffect(() => { setProviderHandoffSessionId(null) }, [currentSessionId, canHandoff])
  const handleProviderHandoff = useCallback(() => {
    if (canHandoff) setProviderHandoffSessionId(currentSessionId)
  }, [currentSessionId, canHandoff])
  const handleProviderHandoffOpenChange = useCallback((open: boolean) => {
    setProviderHandoffSessionId((owner) => open ? currentSessionId : owner === currentSessionId ? null : owner)
  }, [currentSessionId])

  // Collect all error messages for toast display — first non-null wins
  const activeError = actions.loadError || createError || null
  let clearActiveError: (() => void) | undefined
  if (actions.loadError) clearActiveError = actions.clearLoadError
  else if (createError) clearActiveError = clearCreateError

  const showSseWarning = Boolean(
    hasSession
    && state.sessionSource
    && sseState === "disconnected",
  )

  // ─── Build context values ──────────────────────────────────────────────────

  const appContextValue = useMemo(() => ({
    state,
    dispatch,
    config,
    theme: themeCtx,
    isMobile,
  }), [state, dispatch, config, themeCtx, isMobile])

  const handleAddComposerContext = useCallback((item: ComposerContextItem, attachments?: ComposerAttachment[]): string | null => {
    const input = chatInputRef.current
    if (!input) return "Open a session or start a new one to add context"
    const refusal = input.addContext(item, attachments)
    if (isMobile) dispatch({ type: "SET_MOBILE_TAB", tab: "chat" })
    requestAnimationFrame(() => chatInputRef.current?.focus())
    return refusal
  }, [isMobile, dispatch])

  const handleOpenQuoteSource = useQuoteNavigation({
    getSession,
    sessionSource: state.sessionSource,
    loadSession: handlers.handleLoadSessionScrollAware,
    jumpToTurn: useCallback((index: number) => {
      if (isMobile) dispatch({ type: "SET_MOBILE_TAB", tab: "chat" })
      actions.handleJumpToTurn(index)
    }, [actions, isMobile, dispatch]),
    hasMore: chunkedSession.hasMore,
    loadMore: chunkedSession.loadMore,
  })

  // Everything the session context carries but the session itself, which the
  // provider reads from the store. Chat and scroll live in their own context.
  const sessionControls = useMemo<SessionControls>(() => ({
    sessionSource: state.sessionSource,
    isLive,
    sseState,
    isCompacting,
    turnError,
    promptSuggestion,
    rateLimit,
    undoRedo,
    pendingInteraction,
    permissionRequests: permReqs.requests,
    permissionResponding: permReqs.responding,
    respondPermission: permReqs.respond,
    respondAllPermissions: permReqs.respondAll,
    isSubAgentView,
    permissions: sessionPermissions,
    slashSuggestions: slashSuggestions.suggestions,
    slashSuggestionsLoading: slashSuggestions.loading,
    actions: {
      handleStopSession: handlers.handleStopSession,
      handleEditConfig: configAdminEnabled ? panels.handleEditConfig : undefined,
      handleEditCommand: configAdminEnabled ? handleEditCommand : undefined,
      handleExpandCommand: configAdminEnabled ? handleExpandCommand : undefined,
      handleOpenBranches: handlers.handleOpenBranches,
      handleBranchFromHere: handlers.handleBranchFromHere,
      handleToggleExpandAll,
      handleLoadSession: handlers.handleLoadSessionScrollAware,
      handleProviderHandoff: canHandoff ? handleProviderHandoff : undefined,
      handleAddComposerContext,
      handleOpenQuoteSource,
    },
  }), [
    state.sessionSource,
    isLive, sseState, isCompacting, turnError, promptSuggestion, rateLimit,
    undoRedo, pendingInteraction, isSubAgentView, sessionPermissions,
    permReqs.requests, permReqs.responding, permReqs.respond, permReqs.respondAll,
    slashSuggestions.suggestions, slashSuggestions.loading,
    handlers.handleStopSession, configAdminEnabled, panels.handleEditConfig, handleEditCommand, handleExpandCommand,
    handlers.handleOpenBranches, handlers.handleBranchFromHere, handleToggleExpandAll,
    handlers.handleLoadSessionScrollAware,
    canHandoff, handleProviderHandoff, handleAddComposerContext, handleOpenQuoteSource,
  ])

  // The chat's status and actions; the provider pairs them with its scroll state.
  const chatState = useMemo<ChatState>(() => ({
    status: agentChat.status,
    error: agentChat.error,
    pendingMessages: agentChat.pendingMessages,
    isConnected: agentChat.isConnected,
    sendMessage: agentChat.sendMessage,
    interrupt: agentChat.interrupt,
    stopAgent: agentChat.stopAgent,
    consumePending: agentChat.consumePending,
  }), [
    agentChat.status, agentChat.error, agentChat.pendingMessages, agentChat.isConnected,
    agentChat.sendMessage, agentChat.interrupt, agentChat.stopAgent, agentChat.consumePending,
  ])

  // A deep link opens its session while the gates below still wait, so every
  // screen App returns sits in this provider: the transcript's scroll host then
  // sees that session open, as it does any later one.
  const withOpenSession = (node: ReactNode) => (
    <OpenSessionProvider
      store={sessionStore}
      controls={sessionControls}
      chat={chatState}
      isLive={isLive}
      scrollHandle={chatScroll}
      onSessionShown={sessionShown}
    >
      {node}
    </OpenSessionProvider>
  )

  const isNewSession = !!state.pendingDirName && !hasSession

  // Opening a new session should land the caret in the composer right away.
  // Stays above the early-return gates below so hook order never changes.
  useEffect(() => {
    if (!isNewSession || isMobile) return
    const raf = requestAnimationFrame(() => chatInputRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [isNewSession, isMobile, state.pendingDirName])

  // The server's own edition UI did not download, and its screens need it.
  if (editionLoad.failed) return withOpenSession(<EditionUiFailedScreen onRetry={editionLoad.retry} />)

  // ─── AUTH GATE (remote clients + local browsers on account sign-in) ─────────
  // A server of another edition also waits for its UI, so its sign-in and
  // setup screens are the edition's own.
  if (!networkAuth.authChecked || !editionLoad.serverReady) {
    return withOpenSession(
      <div
        className="dark flex h-dvh items-center justify-center bg-canvas"
        role="status"
        aria-label="Checking authentication"
      >
        <Loader2 data-icon="inline-start" className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!networkAuth.authenticated) {
    // A server with account sign-in but no accounts has nobody to sign in as
    // yet, so its first-time setup comes first. Password sign-in never asks.
    const EditionSetupScreen = editionUi.SetupScreen
    if (networkAuth.setupRequired && EditionSetupScreen) {
      return withOpenSession(
        <EditionSetupScreen
          onAuthenticated={networkAuth.handleAuthenticated}
          onSetupClosed={networkAuth.refreshServerState}
        />
      )
    }
    return withOpenSession(<LoginScreen onAuthenticated={networkAuth.handleAuthenticated} setupRequired={networkAuth.setupRequired} />)
  }

  // Do not mount privileged providers or child fetch effects under the
  // optimistic personal defaults while the signed-in account's capabilities
  // load, or while a device of another edition loads that edition's UI.
  if (!identityReady || !editionLoad.ready) {
    return withOpenSession(
      <div
        className="dark flex h-dvh items-center justify-center bg-canvas"
        role="status"
        aria-label="Loading identity"
      >
        <Loader2 data-icon="inline-start" className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ─── SERVER GATE ────────────────────────────────────────────────────────────
  // The server serves only what can let the caller back in until the gate
  // lifts. The app's status toasts would only report those refusals, so they
  // are cleared and the gate screen's own toasts show alone.
  if (me.gate) {
    const GateScreen = editionUi.GateScreen ?? DefaultGateScreen
    return withOpenSession(
      <>
        <GateScreen gate={me.gate} onRestored={reloadApp} onLogout={networkAuth.logout} />
        <AppStatusToasts
          activeError={null}
          modelFallbackNotice={null}
          dismissModelFallbackNotice={dismissModelFallbackNotice}
          connectionLost={false}
          theme={themeCtx.activeTheme}
        />
      </>
    )
  }

  // ─── CONFIG GATE ────────────────────────────────────────────────────────────
  if (config.configLoading) {
    return withOpenSession(
      <div className="dark flex h-dvh items-center justify-center bg-canvas" role="status" aria-label="Loading">
        <Loader2 data-icon="inline-start" className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (config.configError) {
    return withOpenSession(
      <div className="dark flex h-dvh items-center justify-center bg-canvas text-foreground">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertTriangle className="text-destructive" />
            </EmptyMedia>
            <EmptyTitle>Failed to connect</EmptyTitle>
            <EmptyDescription>{config.configError}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={config.retryConfig}>
              <RefreshCw data-icon="inline-start" />
              Retry
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  if (!config.claudeDir) {
    if (configAdminEnabled) return withOpenSession(<SetupScreen onConfigured={config.retryConfig} />)
    return withOpenSession(
      <div className="dark flex h-dvh items-center justify-center bg-canvas text-sm text-muted-foreground">
        Cogpit is waiting for an administrator to finish server setup.
      </div>
    )
  }

  // ─── Shared elements ──────────────────────────────────────────────────────

  const toasterNode = (
    <AppStatusToasts
      activeError={activeError}
      clearActiveError={clearActiveError}
      modelFallbackNotice={modelFallbackNotice}
      dismissModelFallbackNotice={dismissModelFallbackNotice}
      connectionLost={showSseWarning}
      theme={themeCtx.activeTheme}
    />
  )
  const undoConfirmDialog = hostFilesEnabled ? (
    <UndoConfirmDialog
      state={undoRedo.confirmState}
      isApplying={undoRedo.isApplying}
      applyError={undoRedo.applyError}
      onConfirm={undoRedo.confirmApply}
      onCancel={undoRedo.confirmCancel}
    />
  ) : null

  const branchModalCurrentTurns = renderedBranchModalTurn !== null && branchModalTurns
    ? branchModalTurns.slice(renderedBranchModalTurn)
    : []

  const branchModal = hostFilesEnabled && renderedBranchModalTurn !== null && branchModalBranches.length > 0 && (
    <Suspense fallback={null}>
      <BranchModal
        open={branchModalOpen}
        branches={branchModalBranches}
        branchPointTurnIndex={renderedBranchModalTurn}
        currentTurns={branchModalCurrentTurns}
        onClose={handlers.handleCloseBranchModal}
        onCloseComplete={() => setRetainedBranchModalTurn(null)}
        onRedoToTurn={handleRedoToTurn}
        onRedoEntireBranch={handleRedoEntireBranch}
      />
    </Suspense>
  )

  const processPanelNode = terminalEnabled && (
    <ProcessPanel
      processes={processPanel.processes}
      activeProcessId={processPanel.activeProcessId}
      collapsed={processPanel.collapsed}
      onSetActive={processPanel.setActive}
      onRemove={processPanel.removeProcess}
      onToggleCollapse={processPanel.toggleCollapse}
      onRequestTerminal={can("terminal") ? handleNewIntegratedTerminal : undefined}
      onAddTerminalContext={(selection: string, label?: string) => {
        const value = selection.trim()
        if (value) handleAddComposerContext({ id: newContextId(), kind: "terminal", text: value, ...(label ? { label } : {}) })
      }}
      onUpdateStatus={processPanel.updateProcessStatus}
      projectDir={currentCwd}
      onProcessStarted={processPanel.addProcess}
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
    />
  )

  // Workflow visualization panel — mounted only for sessions that ran a
  // workflow, so its chunk loads lazily and the Sheet can animate open/close.
  const workflowsPanelNode = hasWorkflows && (
    <Suspense fallback={null}>
      <WorkflowsPanel
        key={`${workflowSource.dirName ?? ""}:${workflowSource.sessionId ?? ""}`}
        open={panels.showWorkflows}
        onOpenChange={panels.setShowWorkflows}
        dirName={workflowSource.dirName}
        sessionId={workflowSource.sessionId}
        workflows={sessionWorkflows.workflows}
        isLive={sessionWorkflows.isLive}
        canStop={sessionPermissions.stop}
        onRefetchList={sessionWorkflows.refetch}
      />
    </Suspense>
  )

  const goalSessionId = agentCapabilities.goals ? sessionId : null

  const buildChatInputSettings = (includeGoal: boolean) => (
    <ChatInputSettings
      mobile={isMobile}
      agentKind={currentAgentKind}
      onAgentKindChange={isNewSession ? pendingAgentKindChange : undefined}
      selectedModel={selectedModel}
      onModelChange={setSelectedModel}
      selectedEffort={effectiveEffort}
      onEffortChange={setSelectedEffort}
      contextWindowTokens={contextWindowTokens}
      onContextWindowTokensChange={contextWindowAvailable ? setContextWindowTokens : undefined}
      fastModeEnabled={fastModeActive}
      onFastModeEnabledChange={fastModeAvailable ? setFastModeEnabled : undefined}
      isNewSession={isNewSession}
      worktreeEnabled={worktreeEnabled}
      onWorktreeEnabledChange={isNewSession && supportsWorktrees ? setWorktreeEnabled : undefined}
      ultracodeEnabled={ultracodeActive}
      onUltracodeEnabledChange={ultracodeAvailable ? setUltracodeEnabled : undefined}
      onApplySettings={handlers.handleApplySettings}
      activeModelId={sessionModel}
      mcpServers={mcpEnabled ? mcpData.servers : undefined}
      selectedMcpServers={mcpEnabled ? mcpData.selectedServers : undefined}
      onToggleMcpServer={mcpEnabled ? mcpData.toggleServer : undefined}
      onSetMcpServers={mcpEnabled ? mcpData.setSelection : undefined}
      onRefreshMcpServers={mcpEnabled ? mcpData.refresh : undefined}
      mcpLoading={mcpEnabled ? mcpData.loading : undefined}
      onMcpAuth={mcpEnabled ? handleMcpAuth : undefined}
      permissionMode={perms.config.mode}
      onPermissionModeChange={perms.setMode}
      mobileExtra={includeGoal && goalSessionId ? <GoalTrigger /> : undefined}
      trailingExtra={includeGoal && goalSessionId ? <GoalTrigger /> : undefined}
    />
  )
  const chatInputSettingsNode = buildChatInputSettings(true)
  const previewChatInputSettingsNode = buildChatInputSettings(false)

  const composer = (
    <div className={cn("shrink-0", isMobile && "bg-background")}>
      <DelegatedRequests sessionId={isReadOnlySession ? null : sessionId} />
      <GoalSection />
      <ChatInput
        ref={chatInputRef}
        allowImages={imageInputAvailable}
        agentKind={currentAgentKind}
        projectCwd={currentCwd}
        composerIdentity={state.pendingDirName}
        footer={chatInputSettingsNode}
      />
    </div>
  )

  const composerWithQueue = (
    <ConversationComposer
      sessionId={sessionId}
      readOnly={isReadOnlySession || !sessionPermissions.send}
      onOpen={actions.handleDashboardSelect}
      handoffOpen={canHandoff && providerHandoffSessionId === currentSessionId}
      onHandoffOpenChange={handleProviderHandoffOpenChange}
      crewOpen={crewPanelOpen}
      onOpenCrew={openCrewPanel}
    >
      {composer}
    </ConversationComposer>
  )
  const chatInputNode = goalSessionId ? (
    <GoalProvider
      agentKind={currentAgentKind}
      sessionId={goalSessionId}
      onSendCommand={agentChat.sendMessage}
    >
      {composerWithQueue}
    </GoalProvider>
  ) : composerWithQueue

  const previewChatInputNode = (
    <div className={cn("shrink-0", isMobile && "bg-background")}>
      <ChatInput
        ref={chatInputRef}
        allowImages={imageInputAvailable}
        agentKind={currentAgentKind}
        projectCwd={currentCwd}
        composerIdentity={state.pendingDirName}
        footer={previewChatInputSettingsNode}
      />
    </div>
  )

  const pendingPreviewList = agentChat.pendingMessages.length > 0
    ? [<QueuedTurns key="queued" sessionId={null} pendingMessages={agentChat.pendingMessages} canManage={false} isMobile={isMobile} />]
    : []

  // Server discovery when StatsPanel is hidden — StatsPanel has its own BackgroundServers instance
  const statsPanelVisible = isMobile
    ? state.mobileTab === "workspace" && panels.activeWorkspacePanel === BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo
    : panels.activeWorkspacePanel === BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo
  const backgroundServers = hasSession && !statsPanelVisible && (
    <div className="hidden">
      <OpenSessionBackgroundServers onServersChanged={processPanel.handleServersChanged} />
    </div>
  )

  // ─── LOCAL SESSION PREVIEW ────────────────────────────────────────────────
  // Reuse the exact live-session contexts and composer while removing every
  // navigation/dashboard surface from the rendered product.
  if (previewSessionId) {
    return withOpenSession(
      <AppProvider value={appContextValue}>
      <PtyProvider>
      <StreamingOverlayProvider store={streamingOverlayStore} agentProgress={agentProgress}>
        <PreviewAppShell
          sessionId={previewSessionId}
          loadError={previewLoadError}
          searchInputRef={searchInputRef}
          activeComposer={activeReadOnlyNode || previewChatInputNode}
          hasMoreTurns={chunkedSession.hasMore}
          isLoadingOlderTurns={chunkedSession.isLoadingOlder}
          onLoadMoreTurns={chunkedSession.loadMore}
        />
      </StreamingOverlayProvider>
      </PtyProvider>
      {toasterNode}
      </AppProvider>
    )
  }

  // ─── MOBILE LAYOUT ──────────────────────────────────────────────────────────
  if (isMobile) {
    return withOpenSession(
      <AppProvider value={appContextValue}>
      <PtyProvider enabled={terminalEnabled}>
      <StreamingOverlayProvider store={streamingOverlayStore} agentProgress={agentProgress}>
        <MobileAppShell
          navigation={{
            panels,
            actions,
            handlers,
            creatingSession,
            pendingSession: pendingSessionInfo,
            onStartNewSession: handleStartNewSession,
            onStartNewSessionWith: handleStartNewSessionWith,
            newSessionModel,
            onStartNewFolder: handleStartNewFolder,
            onSelectProject: handleSelectProject,
            liveSessionsRefreshRef,
            onPrefetchSession: prefetchSession,
          }}
          sessionView={{
            chatInputRef,
            searchInputRef,
            teamMembersBar,
            activeComposer: activeReadOnlyNode || chatInputNode,
            pendingComposer: chatInputNode,
            pendingTurns: pendingPreviewList,
            todoProgress: todoProgress && <TodoProgressPanel progress={todoProgress} />,
            hasMoreTurns: chunkedSession.hasMore,
            isLoadingOlderTurns: chunkedSession.isLoadingOlder,
            onLoadMoreTurns: chunkedSession.loadMore,
            onBackToMain: handleBackToMain,
            onShowWorkflows: handleShowWorkflows,
            onToggleExpandAll: handleToggleExpandAll,
            workflowCount: workflowBadgeCount,
            pendingPath,
          }}
          project={{
            currentCwd,
            supportsWorktrees,
            worktrees: worktreeData,
            projectFilesRoot,
            projectFilesRequest,
            processPanel,
            backgroundAgents,
            hasFileChanges: hostFilesEnabled && hasFileChanges,
            onOpenTerminal: handleOpenTerminal,
          }}
          chrome={{
            backgroundServers,
            processPanel: processPanelNode,
            workflowsPanel: workflowsPanelNode,
            undoDialog: undoConfirmDialog,
            branchModal,
            fileChangesOpen: showMobileFileChanges,
            onFileChangesOpenChange: setShowMobileFileChanges,
            onLogout: networkAuth.logout,
          }}
        />
      </StreamingOverlayProvider>
      </PtyProvider>
      {toasterNode}
      </AppProvider>
    )
  }

  // ─── DESKTOP LAYOUT ─────────────────────────────────────────────────────────
  return withOpenSession(
    <AppProvider value={appContextValue}>
    <PtyProvider enabled={terminalEnabled}>
      <StreamingOverlayProvider store={streamingOverlayStore} agentProgress={agentProgress}>
        <DesktopAppShell
          navigation={{
            panels,
            actions,
            handlers,
            creatingSession,
            pendingSession: pendingSessionInfo,
            onStartNewSession: handleStartNewSession,
            onStartNewSessionWith: handleStartNewSessionWith,
            newSessionModel,
            onStartNewFolder: handleStartNewFolder,
            onSelectProject: handleSelectProject,
            onOpenPaletteProject: handleOpenPaletteProject,
            liveSessionsRefreshRef,
            onPrefetchSession: prefetchSession,
          }}
          sessionView={{
            searchInputRef,
            chatInputRef,
            teamMembersBar,
            activeComposer: activeReadOnlyNode || chatInputNode,
            pendingComposer: chatInputNode,
            pendingTurns: pendingPreviewList,
            todoProgress,
            todosExpanded,
            onTodosExpandedChange: handleTodosExpandedChange,
            hasMoreTurns: chunkedSession.hasMore,
            isLoadingOlderTurns: chunkedSession.isLoadingOlder,
            onLoadMoreTurns: chunkedSession.loadMore,
            onBackToMain: handleBackToMain,
            onShowWorkflows: handleShowWorkflows,
            workflowCount: workflowBadgeCount,
          }}
          project={{
            processPanel,
            worktrees: worktreeData,
            backgroundAgents,
            supportsWorktrees,
            hasFileChanges: hostFilesEnabled && hasFileChanges,
            currentCwd,
            showPreview,
            showProjectFiles: hostFilesEnabled && showProjectFiles,
            projectFilesRoot,
            projectFilesRequest,
            launchTerminalRequest,
            pendingProject,
            onOpenTerminal: handleOpenTerminal,
            onTogglePreview: handleTogglePreview,
            onToggleProjectFiles: handleToggleProjectFiles,
            onCloseRightWorkspace: closeRightWorkspace,
          }}
          chrome={{
            backgroundServers,
            processPanel: processPanelNode,
            workflowsPanel: workflowsPanelNode,
            undoDialog: undoConfirmDialog,
            branchModal,
            killing,
            onKillAll: handleKillAll,
            commandPaletteOpen: showCommandPalette,
            onCommandPaletteOpenChange: setShowCommandPalette,
            onOpenCommandPalette: handleOpenCommandPalette,
            onFocusComposer: handleFocusComposer,
            onExpandAll: handleExpandAll,
            onExpandToolPayloads: handleExpandToolPayloads,
            onCollapseAll: handleCollapseAll,
            keyboardShortcutsOpen: showKeyboardShortcuts,
            onKeyboardShortcutsOpenChange: setShowKeyboardShortcuts,
            onLogout: networkAuth.logout,
          }}
        />
      </StreamingOverlayProvider>
    </PtyProvider>
    {toasterNode}
    </AppProvider>
  )
}
