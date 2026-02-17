import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import {
  Search,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  BarChart3,
  PanelLeftClose,
  PanelRightClose,
  Check,
  Copy,
  Loader2,
  FolderOpen,
  Skull,
  Plus,
  Settings,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip"
import { SessionBrowser } from "@/components/SessionBrowser"
import { ConversationTimeline } from "@/components/ConversationTimeline"
import { StatsPanel } from "@/components/StatsPanel"
import { FileChangesPanel } from "@/components/FileChangesPanel"
import { TeamsDashboard } from "@/components/TeamsDashboard"
import { TeamMembersBar } from "@/components/TeamMembersBar"
import { Dashboard } from "@/components/Dashboard"
import { MobileNav } from "@/components/MobileNav"
import { useLiveSession } from "@/hooks/useLiveSession"
import { useSessionTeam } from "@/hooks/useSessionTeam"
import { usePtyChat } from "@/hooks/usePtyChat"
import { useIsMobile } from "@/hooks/useIsMobile"
import { useSessionState } from "@/hooks/useSessionState"
import { useChatScroll } from "@/hooks/useChatScroll"
import { useSessionActions } from "@/hooks/useSessionActions"
import { useUrlSync } from "@/hooks/useUrlSync"
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts"
import { ChatInput } from "@/components/ChatInput"
import { ServerPanel } from "@/components/ServerPanel"
import { PermissionsPanel } from "@/components/PermissionsPanel"
import { UndoConfirmDialog } from "@/components/UndoConfirmDialog"
import { BranchModal } from "@/components/BranchModal"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { StickyPromptBanner } from "@/components/StickyPromptBanner"
import { SetupScreen } from "@/components/SetupScreen"
import { ConfigDialog } from "@/components/ConfigDialog"
import { usePermissions } from "@/hooks/usePermissions"
import { useUndoRedo } from "@/hooks/useUndoRedo"
import { parseSession, detectPendingInteraction } from "@/lib/parser"
import { shortenModel, formatTokenCount, getContextUsage } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable"

export default function App() {
  // Config state — gates the entire app
  const [configLoading, setConfigLoading] = useState(true)
  const [claudeDir, setClaudeDir] = useState<string | null>(null)
  const [showConfigDialog, setShowConfigDialog] = useState(false)

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => setClaudeDir(data?.claudeDir ?? null))
      .catch(() => setClaudeDir(null))
      .finally(() => setConfigLoading(false))
  }, [])

  const isMobile = useIsMobile()
  const [state, dispatch] = useSessionState()

  // Local UI state (not shared with hooks)
  const [showSidebar, setShowSidebar] = useState(true)
  const [showStats, setShowStats] = useState(true)
  const [copied, setCopied] = useState(false)
  const [serverMap, setServerMap] = useState<Map<string, { outputPath: string; title: string }>>(new Map())
  const [visibleServerIds, setVisibleServerIds] = useState<Set<string>>(new Set())
  const [serverPanelCollapsed, setServerPanelCollapsed] = useState(false)
  const serverStateCacheRef = useRef<Map<string, { visibleIds: string[]; collapsed: boolean }>>(new Map())
  const prevSessionIdRef = useRef<string | null>(null)

  const searchInputRef = useRef<HTMLInputElement>(null)

  // Save/restore server panel state when switching sessions
  useEffect(() => {
    const currentId = state.session?.sessionId ?? null
    const prevId = prevSessionIdRef.current
    if (prevId && prevId !== currentId) {
      serverStateCacheRef.current.set(prevId, {
        visibleIds: [...visibleServerIds],
        collapsed: serverPanelCollapsed,
      })
    }
    if (currentId !== prevId) {
      const cached = currentId ? serverStateCacheRef.current.get(currentId) : null
      if (cached) {
        setVisibleServerIds(new Set(cached.visibleIds))
        setServerPanelCollapsed(cached.collapsed)
      } else {
        setVisibleServerIds(new Set())
        setServerPanelCollapsed(false)
      }
    }
    prevSessionIdRef.current = currentId
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run on session switch, reads current state via closure
  }, [state.session?.sessionId])

  // Check if session has any Edit/Write tool calls for the file changes panel
  const hasFileChanges = useMemo(() => {
    if (!state.session) return false
    return state.session.turns.some((turn) =>
      turn.toolCalls.some((tc) => tc.name === "Edit" || tc.name === "Write")
    )
  }, [state.session])

  // Detect pending interactive prompts (plan approval, user questions)
  // Stabilize reference: only return a new object when the interaction actually changes,
  // not on every SSE session update. This prevents ChatInput rerenders.
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
  const { isLive } = useLiveSession(state.sessionSource, (updated) => {
    dispatch({ type: "UPDATE_SESSION", session: updated })
  })

  // Permissions management
  const perms = usePermissions()

  // Model override (empty = use session default)
  const [selectedModel, setSelectedModel] = useState("")

  // Claude chat (send messages to session via HTTP API)
  const claudeChat = usePtyChat({
    sessionSource: state.sessionSource,
    parsedSessionId: state.session?.sessionId ?? null,
    cwd: state.session?.cwd,
    permissions: perms.config,
    onPermissionsApplied: perms.markApplied,
    model: selectedModel,
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
      hasSession: !!state.session,
      hasTeam: !!teamContext,
    })
  }, [state.session, teamContext, state.mobileTab, isMobile, dispatch])

  // Scroll management
  const scroll = useChatScroll({
    session: state.session,
    isLive,
    pendingMessage: claudeChat.pendingMessage,
    clearPending: claudeChat.clearPending,
  })

  // Session action handlers
  const actions = useSessionActions({
    dispatch,
    isMobile,
    teamContext,
    scrollToBottomInstant: scroll.scrollToBottomInstant,
    resetTurnCount: scroll.resetTurnCount,
  })

  // Sync URL ↔ state (deep links, back/forward navigation)
  useUrlSync({
    state,
    dispatch,
    isMobile,
    resetTurnCount: scroll.resetTurnCount,
    scrollToBottomInstant: scroll.scrollToBottomInstant,
  })

  // Create a new Claude session in a project directory and open it
  const [creatingSession, setCreatingSession] = useState(false)
  const handleNewSession = useCallback(async (dirName: string) => {
    setCreatingSession(true)
    try {
      const res = await fetch("/api/new-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dirName,
          message: "Hello! I just started a new session.",
          permissions: perms.config,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Unknown error" }))
        console.error("Failed to create new session:", err.error)
        return
      }
      const { dirName: resDirName, fileName } = await res.json()

      // Fetch the JSONL content and load the session
      const contentRes = await fetch(
        `/api/sessions/${encodeURIComponent(resDirName)}/${encodeURIComponent(fileName)}`
      )
      if (!contentRes.ok) return
      const rawText = await contentRes.text()
      const parsed = parseSession(rawText)
      actions.handleLoadSession(parsed, { dirName: resDirName, fileName, rawText })
    } catch (err) {
      console.error("Failed to create new session:", err)
    } finally {
      setCreatingSession(false)
    }
  }, [perms.config, actions])

  // Keyboard shortcuts
  useKeyboardShortcuts({
    isMobile,
    searchInputRef,
    dispatch,
    onToggleSidebar: () => setShowSidebar((p) => !p),
  })

  // Reload session from server (used after undo/redo JSONL mutations)
  const reloadSession = useCallback(async () => {
    if (!state.sessionSource) return
    const { dirName, fileName } = state.sessionSource
    const res = await fetch(
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
  const undoRedo = useUndoRedo(
    state.session,
    state.sessionSource,
    reloadSession,
  )

  // Kill-all handler
  const [killing, setKilling] = useState(false)
  const handleKillAll = useCallback(async () => {
    setKilling(true)
    try {
      await fetch("/api/kill-all", { method: "POST" })
    } catch { /* ignore */ }
    setTimeout(() => setKilling(false), 1500)
  }, [])

  // Server panel handlers
  const handleServersChanged = useCallback((servers: { id: string; outputPath: string; title: string }[]) => {
    setServerMap((prev) => {
      const next = new Map<string, { outputPath: string; title: string }>()
      for (const s of servers) {
        next.set(s.id, { outputPath: s.outputPath, title: s.title })
      }
      if (next.size === prev.size) {
        let same = true
        for (const [k, v] of next) {
          const p = prev.get(k)
          if (!p || p.outputPath !== v.outputPath || p.title !== v.title) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })
    // Clean up visibleIds for servers that no longer exist.
    // Skip when empty — discovery may not have completed yet (e.g. after session switch).
    if (servers.length > 0) {
      const currentIds = new Set(servers.map((s) => s.id))
      setVisibleServerIds((prev) => {
        const next = new Set([...prev].filter((id) => currentIds.has(id)))
        if (next.size === prev.size) return prev
        return next
      })
    }
  }, [])

  const handleToggleServer = useCallback((id: string, outputPath?: string, title?: string) => {
    if (outputPath && title) {
      setServerMap((prev) => {
        if (prev.has(id)) return prev
        const next = new Map(prev)
        next.set(id, { outputPath, title })
        return next
      })
    }
    setVisibleServerIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        setServerPanelCollapsed(false)
      }
      return next
    })
  }, [])

  const [branchModalTurn, setBranchModalTurn] = useState<number | null>(null)
  const branchModalBranches = branchModalTurn !== null ? undoRedo.branchesAtTurn(branchModalTurn) : []

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


  // ─── CONFIG GATE ────────────────────────────────────────────────────────────
  if (configLoading) {
    return (
      <div className="dark flex h-dvh items-center justify-center bg-zinc-950">
        <Loader2 className="size-6 animate-spin text-zinc-500" />
      </div>
    )
  }

  if (!claudeDir) {
    return <SetupScreen onConfigured={(dir) => setClaudeDir(dir)} />
  }

  // ─── MOBILE LAYOUT ──────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div className="dark flex h-dvh flex-col bg-zinc-950 text-zinc-100">
        {/* Mobile Header */}
        <header className="flex h-12 shrink-0 items-center border-b border-zinc-800/80 bg-zinc-900/60 glass px-3">
          {/* Left: Identity */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <button onClick={actions.handleGoHome} className="shrink-0 transition-opacity hover:opacity-70">
              <Eye className="size-4 text-blue-400" />
            </button>
            {state.session ? (
              <>
                <button
                  className="truncate text-sm font-medium text-zinc-300 min-w-0"
                  onClick={() => {
                    const cmd = `claude --resume ${state.session!.sessionId}`
                    navigator.clipboard.writeText(cmd)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  }}
                >
                  {copied ? (
                    <span className="text-green-400">Copied!</span>
                  ) : (
                    state.session.slug || state.session.sessionId.slice(0, 12)
                  )}
                </button>
                {isLive && (
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                  </span>
                )}
                {(() => {
                  const ctx = getContextUsage(state.session.rawMessages)
                  if (!ctx) return null
                  const pctLeft = Math.max(0, 100 - ctx.percent)
                  const borderColor = pctLeft < 10 ? "border-red-700/60" : pctLeft < 30 ? "border-amber-700/60" : "border-green-700/60"
                  const textColor = pctLeft < 10 ? "text-red-400" : pctLeft < 30 ? "text-amber-400" : "text-green-400"
                  const bgColor = pctLeft < 10 ? "bg-red-500/5" : pctLeft < 30 ? "bg-amber-500/5" : "bg-green-500/5"
                  return (
                    <Badge
                      variant="outline"
                      className={`h-5 px-1.5 text-[10px] font-semibold ${borderColor} ${textColor} ${bgColor} shrink-0`}
                    >
                      {pctLeft.toFixed(0)}%
                    </Badge>
                  )
                })()}
              </>
            ) : (
              <h1 className="text-sm font-semibold tracking-tight">Agent Window</h1>
            )}
          </div>

          {/* Right: Actions */}
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-zinc-500 shrink-0"
              onClick={() => setShowConfigDialog(true)}
            >
              <Settings className="size-3.5" />
            </Button>
            {state.session && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-zinc-500 shrink-0"
                onClick={() => {
                  const cmd = `claude --resume ${state.session!.sessionId}`
                  navigator.clipboard.writeText(cmd)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? (
                  <Check className="size-3.5 text-green-400" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            )}
            {state.sessionSource && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-zinc-500 hover:text-green-400"
                disabled={creatingSession}
                onClick={() => handleNewSession(state.sessionSource!.dirName)}
              >
                {creatingSession ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Plus className="size-3.5" />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-zinc-500 hover:text-red-400"
              onClick={handleKillAll}
              disabled={killing}
            >
              <Skull className={cn("size-3.5", killing && "text-red-400 animate-pulse")} />
            </Button>
          </div>
        </header>

        {/* Mobile Tab Content */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Sessions Tab */}
          {state.mobileTab === "sessions" && (
            <SessionBrowser
              session={state.session}
              activeSessionKey={state.sessionSource ? `${state.sessionSource.dirName}/${state.sessionSource.fileName}` : null}
              onLoadSession={actions.handleLoadSession}
              sidebarTab={state.sidebarTab}
              onSidebarTabChange={(tab) => dispatch({ type: "SET_SIDEBAR_TAB", tab })}
              onSelectTeam={actions.handleSelectTeam}
              onNewSession={handleNewSession}
              creatingSession={creatingSession}
              isMobile
            />
          )}

          {/* Chat Tab */}
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
                  {/* Team members bar */}
                  {teamContext && (
                    <TeamMembersBar
                      teamName={teamContext.config.name || teamContext.teamName}
                      members={teamContext.config.members}
                      currentMemberName={state.currentMemberName}
                      loadingMember={state.loadingMember}
                      onMemberClick={actions.handleTeamMemberSwitch}
                      onTeamClick={actions.handleOpenTeamFromBar}
                    />
                  )}
                  {/* Session info bar */}
                  <div className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800/50 bg-zinc-950/80 px-2">
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                      {shortenModel(state.session.model)}
                    </Badge>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal text-zinc-500 border-zinc-700">
                      {state.session.turns.length} turns
                    </Badge>
                    {(() => {
                      const ctx = getContextUsage(state.session.rawMessages)
                      if (!ctx) return null
                      const pctLeft = Math.max(0, 100 - ctx.percent)
                      const remaining = Math.max(0, ctx.compactAt - ctx.used)
                      const borderColor = pctLeft < 10 ? "border-red-700/60" : pctLeft < 30 ? "border-amber-700/60" : "border-green-700/60"
                      const textColor = pctLeft < 10 ? "text-red-400" : pctLeft < 30 ? "text-amber-400" : "text-green-400"
                      const bgColor = pctLeft < 10 ? "bg-red-500/5" : pctLeft < 30 ? "bg-amber-500/5" : "bg-green-500/5"
                      return (
                        <Badge
                          variant="outline"
                          className={`h-5 px-1.5 text-[10px] font-semibold ${borderColor} ${textColor} ${bgColor}`}
                        >
                          {pctLeft.toFixed(0)}% · {formatTokenCount(remaining)}
                        </Badge>
                      )
                    })()}
                    <div className="flex-1" />
                    {state.sessionSource && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 gap-1 text-[11px] text-zinc-500 hover:text-green-400"
                        disabled={creatingSession}
                        onClick={() => handleNewSession(state.sessionSource!.dirName)}
                      >
                        {creatingSession ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
                        New
                      </Button>
                    )}
                  </div>
                  {/* Search bar */}
                  <div className="flex items-center gap-1.5 shrink-0 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-sm px-2 py-1.5">
                    <div className="relative flex-1">
                      <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
                      <Input
                        ref={searchInputRef}
                        value={state.searchQuery}
                        onChange={(e) => dispatch({ type: "SET_SEARCH_QUERY", value: e.target.value })}
                        placeholder="Search conversation..."
                        className="h-8 bg-zinc-900/50 pl-8 text-sm border-zinc-700/50 placeholder:text-zinc-600 focus-visible:ring-blue-500/30"
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 shrink-0"
                      onClick={() => dispatch({ type: "TOGGLE_EXPAND_ALL" })}
                    >
                      {state.expandAll ? (
                        <ChevronsDownUp className="size-4" />
                      ) : (
                        <ChevronsUpDown className="size-4" />
                      )}
                    </Button>
                  </div>
                  <div className="relative flex-1 min-h-0">
                    <StickyPromptBanner
                      session={state.session}
                      scrollContainerRef={scroll.chatScrollRef}
                    />
                    <div
                      className={cn(
                        "pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-zinc-950 to-transparent transition-opacity duration-200",
                        scroll.canScrollUp ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <div
                      ref={scroll.chatScrollRef}
                      onScroll={scroll.handleScroll}
                      className="h-full overflow-y-auto mobile-scroll"
                    >
                      <div className="py-3 px-1">
                        <ErrorBoundary fallbackMessage="Failed to render conversation timeline">
                        <ConversationTimeline
                          session={state.session}
                          activeTurnIndex={state.activeTurnIndex}
                          activeToolCallId={state.activeToolCallId}
                          searchQuery={state.searchQuery}
                          expandAll={state.expandAll}
                          scrollContainerRef={scroll.chatScrollRef}
                          branchesAtTurn={undoRedo.branchesAtTurn}
                          onRestoreToHere={undoRedo.requestUndo}
                          onOpenBranches={(turnIndex) => setBranchModalTurn(turnIndex)}
                          canRedo={undoRedo.canRedo}
                          redoTurnCount={undoRedo.redoTurnCount}
                          redoGhostTurns={undoRedo.redoGhostTurns}
                          onRedoAll={undoRedo.requestRedoAll}
                          onRedoUpTo={undoRedo.requestRedoUpTo}
                        />
                        {claudeChat.pendingMessage && (
                          <div className="mx-3 mt-3 space-y-3">
                            <div className="flex justify-end">
                              <div className="max-w-[85%] rounded-lg bg-blue-600/20 border border-blue-500/20 px-3 py-2 text-sm text-zinc-200">
                                {claudeChat.pendingMessage}
                              </div>
                            </div>
                            {claudeChat.isConnected && (
                              <div className="flex items-center gap-2 text-zinc-500">
                                <Loader2 className="size-3.5 animate-spin text-blue-400" />
                                <span className="text-xs">Agent is working...</span>
                              </div>
                            )}
                          </div>
                        )}
                        <div ref={scroll.scrollEndRef} />
                        </ErrorBoundary>
                      </div>
                    </div>
                    <div
                      className={cn(
                        "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-zinc-950 to-transparent transition-opacity duration-200",
                        scroll.canScrollDown ? "opacity-100" : "opacity-0"
                      )}
                    />
                  </div>
                </div>
              ) : (
                <Dashboard
                  onSelectSession={actions.handleDashboardSelect}
                  onNewSession={handleNewSession}
                  creatingSession={creatingSession}
                  selectedProjectDirName={state.dashboardProject}
                  onSelectProject={(dirName) => dispatch({ type: "SET_DASHBOARD_PROJECT", dirName })}
                />
              )}
            </div>
          )}

          {/* Stats Tab */}
          {state.mobileTab === "stats" && state.session && (
            <StatsPanel
              session={state.session}
              onJumpToTurn={(index, toolCallId) => {
                actions.handleJumpToTurn(index, toolCallId)
                dispatch({ type: "SET_MOBILE_TAB", tab: "chat" })
              }}
              onToggleServer={handleToggleServer}
              onServersChanged={handleServersChanged}
              isMobile
              permissionsPanel={permissionsPanelNode}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
            />
          )}

          {/* Teams Tab */}
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
                  activeSessionKey={state.sessionSource ? `${state.sessionSource.dirName}/${state.sessionSource.fileName}` : null}
                  onLoadSession={actions.handleLoadSession}
                  sidebarTab="teams"
                  onSidebarTabChange={(tab) => dispatch({ type: "SET_SIDEBAR_TAB", tab })}
                  onSelectTeam={actions.handleSelectTeam}
                  isMobile
                  teamsOnly
                />
              )}
            </div>
          )}

        </div>

        {/* Server panel - multi-server split view */}
        {serverMap.size > 0 && (
          <ServerPanel
            servers={serverMap}
            visibleIds={visibleServerIds}
            collapsed={serverPanelCollapsed}
            onToggleServer={(id) => handleToggleServer(id)}
            onToggleCollapse={() => setServerPanelCollapsed((p) => !p)}
          />
        )}

        {/* Chat input - only on chat tab with session */}
        {state.mobileTab === "chat" && state.session && state.mainView !== "teams" && (
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
        )}

        {/* Bottom Navigation */}
        <MobileNav
          activeTab={state.mobileTab}
          onTabChange={actions.handleMobileTabChange}
          hasSession={!!state.session}
          hasTeam={!!teamContext}
          isLive={isLive}
        />

        {/* Undo/Redo dialogs */}
        <UndoConfirmDialog
          state={undoRedo.confirmState}
          isApplying={undoRedo.isApplying}
          applyError={undoRedo.applyError}
          onConfirm={undoRedo.confirmApply}
          onCancel={undoRedo.confirmCancel}
        />

        {branchModalTurn !== null && branchModalBranches.length > 0 && (
          <BranchModal
            branches={branchModalBranches}
            branchPointTurnIndex={branchModalTurn}
            onClose={() => setBranchModalTurn(null)}
            onRedoToTurn={(branchId, archiveTurnIdx) => {
              undoRedo.requestBranchSwitch(branchId, archiveTurnIdx)
              setBranchModalTurn(null)
            }}
            onRedoEntireBranch={(branchId) => {
              undoRedo.requestBranchSwitch(branchId)
              setBranchModalTurn(null)
            }}
          />
        )}
      </div>
    )
  }

  // ─── DESKTOP LAYOUT ─────────────────────────────────────────────────────────
  return (
    <div className="dark flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      {/* Header — app-level controls only */}
      <header className="flex h-11 shrink-0 items-center border-b border-zinc-800/80 bg-zinc-900/60 glass px-3">
        <div className="flex items-center gap-2 min-w-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={actions.handleGoHome}
                className="shrink-0 transition-opacity hover:opacity-70"
              >
                <Eye className="size-4 text-blue-400" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{state.session ? "Back to Dashboard" : "Agent Window"}</TooltipContent>
          </Tooltip>

          {state.session ? (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="truncate max-w-[220px] text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
                    onClick={() => {
                      const cmd = `claude --resume ${state.session!.sessionId}`
                      navigator.clipboard.writeText(cmd)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                  >
                    {copied ? (
                      <span className="flex items-center gap-1.5 text-green-400">
                        <Check className="size-3" /> Copied
                      </span>
                    ) : (
                      state.session.slug || state.session.sessionId.slice(0, 8)
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent className="text-xs space-y-1">
                  <div>Click to copy resume command</div>
                  {state.session.cwd && (
                    <div className="font-mono text-zinc-400">{state.session.cwd}</div>
                  )}
                </TooltipContent>
              </Tooltip>
              {isLive && (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-zinc-500 hover:text-zinc-200"
                    onClick={() => {
                      const cmd = `claude --resume ${state.session!.sessionId}`
                      navigator.clipboard.writeText(cmd)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }}
                  >
                    {copied ? (
                      <Check className="size-3 text-green-400" />
                    ) : (
                      <Copy className="size-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {copied ? "Copied!" : "Copy resume command"}
                </TooltipContent>
              </Tooltip>
            </>
          ) : (
            <h1 className="text-sm font-semibold tracking-tight">Agent Window</h1>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-zinc-500 hover:text-zinc-200"
                onClick={() => setShowConfigDialog(true)}
              >
                <Settings className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-zinc-500 hover:text-red-400 hover:bg-red-500/10"
                onClick={handleKillAll}
                disabled={killing}
              >
                <Skull className={cn("size-3.5", killing && "text-red-400 animate-pulse")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Kill all Claude processes</TooltipContent>
          </Tooltip>
          {state.session && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setShowStats(!showStats)}>
                  {showStats ? <PanelRightClose className="size-3.5" /> : <BarChart3 className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{showStats ? "Hide Stats" : "Show Stats"}</TooltipContent>
            </Tooltip>
          )}
          {(state.session || showSidebar) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setShowSidebar(!showSidebar)}>
                  {showSidebar ? <PanelLeftClose className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{showSidebar ? "Hide Sidebar (Ctrl+B)" : "Show Sidebar (Ctrl+B)"}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Sidebar */}
        {showSidebar && (
          <SessionBrowser
            session={state.session}
            activeSessionKey={state.sessionSource ? `${state.sessionSource.dirName}/${state.sessionSource.fileName}` : null}
            onLoadSession={actions.handleLoadSession}
            sidebarTab={state.sidebarTab}
            onSidebarTabChange={(tab) => dispatch({ type: "SET_SIDEBAR_TAB", tab })}
            onSelectTeam={actions.handleSelectTeam}
            onNewSession={handleNewSession}
            creatingSession={creatingSession}
          />
        )}

        {/* Center Content */}
        <main className="relative flex-1 min-w-0 overflow-hidden flex flex-col">
          {state.mainView === "teams" && state.selectedTeam ? (
            <TeamsDashboard
              teamName={state.selectedTeam}
              onBack={actions.handleBackFromTeam}
              onOpenSession={actions.handleOpenSessionFromTeam}
            />
          ) : state.session ? (
            <div className="flex flex-1 min-h-0 flex-col">
              {/* Team members bar - shown when session belongs to a team */}
              {teamContext && (
                <TeamMembersBar
                  teamName={teamContext.config.name || teamContext.teamName}
                  members={teamContext.config.members}
                  currentMemberName={state.currentMemberName}
                  loadingMember={state.loadingMember}
                  onMemberClick={actions.handleTeamMemberSwitch}
                  onTeamClick={actions.handleOpenTeamFromBar}
                />
              )}

              {/* Session info bar */}
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800/50 bg-zinc-950/80 px-3">
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  {shortenModel(state.session.model)}
                </Badge>
                <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal text-zinc-500 border-zinc-700">
                  {state.session.turns.length} turns
                </Badge>
                {(() => {
                  const ctx = getContextUsage(state.session.rawMessages)
                  if (!ctx) return null
                  const pctLeft = Math.max(0, 100 - ctx.percent)
                  const remaining = Math.max(0, ctx.compactAt - ctx.used)
                  const borderColor = pctLeft < 10 ? "border-red-700/60" : pctLeft < 30 ? "border-amber-700/60" : "border-green-700/60"
                  const textColor = pctLeft < 10 ? "text-red-400" : pctLeft < 30 ? "text-amber-400" : "text-green-400"
                  const bgColor = pctLeft < 10 ? "bg-red-500/5" : pctLeft < 30 ? "bg-amber-500/5" : "bg-green-500/5"
                  return (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className={`h-5 px-1.5 text-[10px] font-semibold ${borderColor} ${textColor} ${bgColor} gap-1`}
                        >
                          {pctLeft.toFixed(0)}% · {formatTokenCount(remaining)}
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="text-xs space-y-1">
                        <div className="font-medium">Context Left Until Auto-Compact</div>
                        <div>{formatTokenCount(remaining)} remaining ({pctLeft.toFixed(1)}%)</div>
                        <div className="text-zinc-400">
                          {formatTokenCount(ctx.used)} / {formatTokenCount(ctx.limit)} tokens used ({ctx.percentAbsolute.toFixed(1)}%)
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  )
                })()}

                <div className="flex-1" />

                {state.sessionSource && (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 gap-1.5 text-[11px] text-zinc-500 hover:text-green-400 hover:bg-green-500/10"
                          disabled={creatingSession}
                          onClick={() => handleNewSession(state.sessionSource!.dirName)}
                        >
                          {creatingSession ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Plus className="size-3" />
                          )}
                          New
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>New session in this project</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-200"
                          onClick={() => {
                            const dirName = state.sessionSource!.dirName
                            dispatch({ type: "GO_HOME", isMobile: false })
                            dispatch({ type: "SET_DASHBOARD_PROJECT", dirName })
                          }}
                        >
                          <FolderOpen className="size-3" />
                          All Sessions
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>View all sessions in this project</TooltipContent>
                    </Tooltip>
                  </>
                )}
              </div>

              <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
                {/* Left: Conversation Timeline */}
                <ResizablePanel defaultSize={hasFileChanges ? 50 : 100} minSize="500px">
                  <div className="relative h-full">
                    <StickyPromptBanner
                      session={state.session}
                      scrollContainerRef={scroll.chatScrollRef}
                    />
                    <div
                      className={cn(
                        "pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-zinc-950 to-transparent transition-opacity duration-200",
                        scroll.canScrollUp ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <div
                      ref={scroll.chatScrollRef}
                      onScroll={scroll.handleScroll}
                      className="h-full overflow-y-auto"
                    >
                      <div className="mx-auto max-w-4xl py-4">
                        <ErrorBoundary fallbackMessage="Failed to render conversation timeline">
                        <ConversationTimeline
                          session={state.session}
                          activeTurnIndex={state.activeTurnIndex}
                          activeToolCallId={state.activeToolCallId}
                          searchQuery={state.searchQuery}
                          expandAll={state.expandAll}
                          scrollContainerRef={scroll.chatScrollRef}
                          branchesAtTurn={undoRedo.branchesAtTurn}
                          onRestoreToHere={undoRedo.requestUndo}
                          onOpenBranches={(turnIndex) => setBranchModalTurn(turnIndex)}
                          canRedo={undoRedo.canRedo}
                          redoTurnCount={undoRedo.redoTurnCount}
                          redoGhostTurns={undoRedo.redoGhostTurns}
                          onRedoAll={undoRedo.requestRedoAll}
                          onRedoUpTo={undoRedo.requestRedoUpTo}
                        />
                        {claudeChat.pendingMessage && (
                          <div className="mx-4 mt-4 space-y-3">
                            <div className="flex justify-end">
                              <div className="max-w-[80%] rounded-lg bg-blue-600/20 border border-blue-500/20 px-3 py-2 text-sm text-zinc-200">
                                {claudeChat.pendingMessage}
                              </div>
                            </div>
                            {claudeChat.isConnected && (
                              <div className="flex items-center gap-2 text-zinc-500">
                                <Loader2 className="size-3.5 animate-spin text-blue-400" />
                                <span className="text-xs">Agent is working...</span>
                              </div>
                            )}
                          </div>
                        )}
                        <div ref={scroll.scrollEndRef} />
                        </ErrorBoundary>
                      </div>
                    </div>
                    <div
                      className={cn(
                        "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-zinc-950 to-transparent transition-opacity duration-200",
                        scroll.canScrollDown ? "opacity-100" : "opacity-0"
                      )}
                    />
                  </div>
                </ResizablePanel>

                {/* Resize handle + File Changes Panel */}
                {hasFileChanges && (
                  <>
                    <ResizableHandle withHandle />
                    <ResizablePanel defaultSize={50} minSize={0} collapsible>
                      <FileChangesPanel session={state.session} sessionChangeKey={state.sessionChangeKey} />
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>

              {/* Chat input — inside the chat view */}
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
            </div>
          ) : (
            <Dashboard
              onSelectSession={actions.handleDashboardSelect}
              onNewSession={handleNewSession}
              creatingSession={creatingSession}
              selectedProjectDirName={state.dashboardProject}
              onSelectProject={(dirName) => dispatch({ type: "SET_DASHBOARD_PROJECT", dirName })}
            />
          )}
        </main>

        {/* Right Stats Panel */}
        {showStats && state.session && state.mainView !== "teams" && (
          <StatsPanel
            session={state.session}
            onJumpToTurn={actions.handleJumpToTurn}
            onToggleServer={handleToggleServer}
            onServersChanged={handleServersChanged}
            searchQuery={state.searchQuery}
            onSearchChange={(q) => dispatch({ type: "SET_SEARCH_QUERY", value: q })}
            expandAll={state.expandAll}
            onToggleExpandAll={() => dispatch({ type: "TOGGLE_EXPAND_ALL" })}
            searchInputRef={searchInputRef}
            permissionsPanel={permissionsPanelNode}
            selectedModel={selectedModel}
            onModelChange={setSelectedModel}
          />
        )}
      </div>

      {/* Server panel - multi-server split view */}
      {serverMap.size > 0 && (
        <ServerPanel
          servers={serverMap}
          visibleIds={visibleServerIds}
          collapsed={serverPanelCollapsed}
          onToggleServer={(id) => handleToggleServer(id)}
          onToggleCollapse={() => setServerPanelCollapsed((p) => !p)}
        />
      )}

      {/* Undo/Redo dialogs */}
      <UndoConfirmDialog
        state={undoRedo.confirmState}
        isApplying={undoRedo.isApplying}
        applyError={undoRedo.applyError}
        onConfirm={undoRedo.confirmApply}
        onCancel={undoRedo.confirmCancel}
      />

      {branchModalTurn !== null && branchModalBranches.length > 0 && (
        <BranchModal
          branches={branchModalBranches}
          branchPointTurnIndex={branchModalTurn}
          onClose={() => setBranchModalTurn(null)}
          onRedoToTurn={(branchId, archiveTurnIdx) => {
            undoRedo.requestBranchSwitch(branchId, archiveTurnIdx)
            setBranchModalTurn(null)
          }}
          onRedoEntireBranch={(branchId) => {
            undoRedo.requestBranchSwitch(branchId)
            setBranchModalTurn(null)
          }}
        />
      )}

      <ConfigDialog
        open={showConfigDialog}
        currentPath={claudeDir!}
        onClose={() => setShowConfigDialog(false)}
        onSaved={(newPath) => {
          setClaudeDir(newPath)
          setShowConfigDialog(false)
          window.location.reload()
        }}
      />

    </div>
  )
}
