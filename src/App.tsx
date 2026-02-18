import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { Loader2, AlertTriangle, RefreshCw, WifiOff, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SessionBrowser } from "@/components/SessionBrowser"
import { StatsPanel } from "@/components/StatsPanel"
import { FileChangesPanel } from "@/components/FileChangesPanel"
import { TeamsDashboard } from "@/components/TeamsDashboard"
import { TeamMembersBar } from "@/components/TeamMembersBar"
import { Dashboard } from "@/components/Dashboard"
import { MobileNav } from "@/components/MobileNav"
import { ChatInput } from "@/components/ChatInput"
import { ServerPanel } from "@/components/ServerPanel"
import { PermissionsPanel } from "@/components/PermissionsPanel"
import { UndoConfirmDialog } from "@/components/UndoConfirmDialog"
import { BranchModal } from "@/components/BranchModal"
import { SetupScreen } from "@/components/SetupScreen"
import { ConfigDialog } from "@/components/ConfigDialog"
import { DesktopHeader } from "@/components/DesktopHeader"
import { MobileHeader } from "@/components/MobileHeader"
import { SessionInfoBar } from "@/components/SessionInfoBar"
import { ChatArea } from "@/components/ChatArea"
import { useLiveSession } from "@/hooks/useLiveSession"
import { useSessionTeam } from "@/hooks/useSessionTeam"
import { usePtyChat } from "@/hooks/usePtyChat"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useSessionState } from "@/hooks/useSessionState"
import { useChatScroll } from "@/hooks/useChatScroll"
import { useSessionActions } from "@/hooks/useSessionActions"
import { useUrlSync } from "@/hooks/useUrlSync"
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts"
import { usePermissions } from "@/hooks/usePermissions"
import { useUndoRedo } from "@/hooks/useUndoRedo"
import { useAppConfig } from "@/hooks/useAppConfig"
import { useServerPanel } from "@/hooks/useServerPanel"
import { useNewSession } from "@/hooks/useNewSession"
import { useKillAll } from "@/hooks/useKillAll"
import { parseSession, detectPendingInteraction } from "@/lib/parser"
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
  const [state, dispatch] = useSessionState()

  // Local UI state
  const [showSidebar, setShowSidebar] = useState(true)
  const [showStats, setShowStats] = useState(true)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Stable callbacks
  const handleSidebarTabChange = useCallback(
    (tab: "browse" | "teams") => dispatch({ type: "SET_SIDEBAR_TAB", tab }),
    [dispatch]
  )
  const handleToggleSidebar = useCallback(() => setShowSidebar((p) => !p), [])
  const handleToggleExpandAll = useCallback(() => dispatch({ type: "TOGGLE_EXPAND_ALL" }), [dispatch])
  const handleSearchChange = useCallback((q: string) => dispatch({ type: "SET_SEARCH_QUERY", value: q }), [dispatch])
  const handleSelectProject = useCallback((dirName: string | null) => dispatch({ type: "SET_DASHBOARD_PROJECT", dirName }), [dispatch])

  // Server panel state
  const serverPanel = useServerPanel(state.session?.sessionId)

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

  // Permissions management
  const perms = usePermissions()

  // Model override (empty = use session default)
  const [selectedModel, setSelectedModel] = useState("")

  // New session creation (lazy — no backend call until first message)
  // Declared before usePtyChat because it provides the onCreateSession callback.
  const sessionFinalizedRef = useRef<((parsed: ParsedSession) => void) | null>(null)
  const { creatingSession, createError, clearCreateError, handleNewSession, createAndSend } = useNewSession({
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
  sessionFinalizedRef.current = (parsed) => {
    scroll.resetTurnCount(parsed.turns.length)
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

  // Keyboard shortcuts
  useKeyboardShortcuts({
    isMobile,
    searchInputRef,
    dispatch,
    onToggleSidebar: handleToggleSidebar,
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

  // Mobile StatsPanel jump callback
  const handleMobileJumpToTurn = useCallback((index: number, toolCallId?: string) => {
    actions.handleJumpToTurn(index, toolCallId)
    dispatch({ type: "SET_MOBILE_TAB", tab: "chat" })
  }, [actions.handleJumpToTurn, dispatch])

  // Kill-all handler
  const { killing, handleKillAll } = useKillAll()

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
      <div className="dark flex h-dvh items-center justify-center bg-zinc-950" role="status" aria-label="Loading">
        <Loader2 className="size-6 animate-spin text-zinc-500" />
      </div>
    )
  }

  if (config.configError) {
    return (
      <div className="dark flex h-dvh flex-col items-center justify-center gap-4 bg-zinc-950 text-zinc-100">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500/10 border border-red-500/20">
          <AlertTriangle className="size-7 text-red-400" />
        </div>
        <div className="text-center space-y-1">
          <h2 className="text-sm font-medium text-zinc-200">Failed to connect</h2>
          <p className="text-xs text-zinc-500 max-w-sm">{config.configError}</p>
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
    <div role="status" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-amber-900/50 bg-zinc-900/95 backdrop-blur-sm px-3 py-2 shadow-lg toast-enter">
      <WifiOff className="size-3.5 text-amber-400" />
      <span className="text-xs text-amber-400">Live connection lost</span>
      <span className="text-[10px] text-zinc-500">Reconnecting automatically...</span>
    </div>
  )

  // Error toast
  const errorToast = activeError && (
    <div role="alert" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-lg border border-red-900/50 bg-zinc-900/95 backdrop-blur-sm px-3 py-2 shadow-lg max-w-md toast-enter">
      <AlertTriangle className="size-3.5 text-red-400 shrink-0" />
      <span className="text-xs text-red-400 flex-1">{activeError}</span>
      {clearActiveError && (
        <button onClick={clearActiveError} className="text-zinc-500 hover:text-zinc-300 shrink-0" aria-label="Dismiss error">
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
        status={claudeChat.status}
        error={claudeChat.error}
        isConnected={claudeChat.isConnected}
        onSend={claudeChat.sendMessage}
        onInterrupt={claudeChat.interrupt}
        onDisconnect={claudeChat.stopAgent}
        permissionMode={perms.config.mode}
        permissionsPending={perms.hasPendingChanges}
        pendingInteraction={pendingInteraction}
      />
    </div>
  )

  // ─── MOBILE LAYOUT ──────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="dark flex h-dvh flex-col bg-zinc-950 text-zinc-100">
        <MobileHeader
          session={state.session}
          sessionSource={state.sessionSource}
          isLive={isLive}
          killing={killing}
          creatingSession={creatingSession}
          networkUrl={config.networkUrl}
          networkAccessDisabled={config.networkAccessDisabled}
          onGoHome={actions.handleGoHome}
          onKillAll={handleKillAll}
          onOpenSettings={config.openConfigDialog}
          onNewSession={handleNewSession}
        />

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
                  />
                  <ChatArea
                    session={state.session}
                    activeTurnIndex={state.activeTurnIndex}
                    activeToolCallId={state.activeToolCallId}
                    searchQuery={state.searchQuery}
                    expandAll={state.expandAll}
                    isMobile
                    dispatch={dispatch}
                    searchInputRef={searchInputRef}
                    chatScrollRef={scroll.chatScrollRef}
                    scrollEndRef={scroll.scrollEndRef}
                    canScrollUp={scroll.canScrollUp}
                    canScrollDown={scroll.canScrollDown}
                    handleScroll={scroll.handleScroll}
                    undoRedo={undoRedo}
                    onOpenBranches={handleOpenBranches}
                    pendingMessage={claudeChat.pendingMessage}
                    isConnected={claudeChat.isConnected}
                    onToggleExpandAll={handleToggleExpandAll}
                  />
                </div>
              ) : state.pendingDirName ? (
                <div className="flex flex-1 min-h-0 flex-col">
                  {claudeChat.pendingMessage ? (
                    <div className="flex-1 overflow-y-auto px-3 py-4">
                      <div className="space-y-3">
                        <div className="flex justify-end">
                          <div className="rounded-lg bg-blue-600/20 border border-blue-500/20 px-3 py-2 text-sm text-zinc-200 max-w-[85%]">
                            {claudeChat.pendingMessage}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-zinc-500">
                          <Loader2 className="size-3.5 animate-spin" />
                          <span className="text-xs">Creating session...</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 flex items-center justify-center">
                      <p className="text-sm text-zinc-500">New session — type your first message below</p>
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
        {state.mobileTab === "chat" && (state.session || state.pendingDirName) && state.mainView !== "teams" && chatInputNode}

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
    <div className="dark flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      <DesktopHeader
        session={state.session}
        isLive={isLive}
        showSidebar={showSidebar}
        showStats={showStats}
        killing={killing}
        networkUrl={config.networkUrl}
        networkAccessDisabled={config.networkAccessDisabled}
        onGoHome={actions.handleGoHome}
        onToggleSidebar={handleToggleSidebar}
        onToggleStats={() => setShowStats(!showStats)}
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
                    dispatch={dispatch}
                    searchInputRef={searchInputRef}
                    chatScrollRef={scroll.chatScrollRef}
                    scrollEndRef={scroll.scrollEndRef}
                    canScrollUp={scroll.canScrollUp}
                    canScrollDown={scroll.canScrollDown}
                    handleScroll={scroll.handleScroll}
                    undoRedo={undoRedo}
                    onOpenBranches={handleOpenBranches}
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

              {chatInputNode}
            </div>
          ) : state.pendingDirName ? (
            <div className="flex flex-1 min-h-0 flex-col">
              {claudeChat.pendingMessage ? (
                <div className="flex-1 overflow-y-auto px-4 py-6">
                  <div className="mx-auto max-w-3xl space-y-4">
                    <div className="flex justify-end">
                      <div className="rounded-lg bg-blue-600/20 border border-blue-500/20 px-3 py-2 text-sm text-zinc-200 max-w-[80%]">
                        {claudeChat.pendingMessage}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-zinc-500">
                      <Loader2 className="size-3.5 animate-spin" />
                      <span className="text-xs">Creating session...</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-sm text-zinc-500">New session — type your first message below</p>
                </div>
              )}
              {chatInputNode}
            </div>
          ) : (
            <Dashboard
              onSelectSession={actions.handleDashboardSelect}
              onNewSession={handleNewSession}
              creatingSession={creatingSession}
              selectedProjectDirName={state.dashboardProject}
              onSelectProject={handleSelectProject}
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
          />
        )}
      </div>

      {serverPanelNode}
      {undoConfirmDialog}
      {branchModal}

      <ConfigDialog
        open={config.showConfigDialog}
        currentPath={config.claudeDir ?? ""}
        onClose={config.handleCloseConfigDialog}
        onSaved={config.handleConfigSaved}
      />

      {errorToast || sseIndicator}
    </div>
  )
}
