import { useState, useEffect, useRef, useMemo, useCallback, startTransition, lazy, Suspense } from "react"
import { Loader2, AlertTriangle, RefreshCw, WifiOff, X, TerminalSquare, Code2, FolderSearch, Bot } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SessionBrowser } from "@/components/SessionBrowser"
import { StatsPanel } from "@/components/StatsPanel"
import { ChatInputSettings } from "@/components/ChatInput/ChatInputSettings"
import { FileChangesPanel } from "@/components/FileChangesPanel"
import { TeamMembersBar } from "@/components/TeamMembersBar"
import { Dashboard } from "@/components/Dashboard"
import { MobileNav } from "@/components/MobileNav"
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput"
import { ProcessPanel } from "@/components/ProcessPanel"
import { BackgroundServers } from "@/components/stats/BackgroundServers"
import { UndoConfirmDialog } from "@/components/UndoConfirmDialog"
import { SetupScreen } from "@/components/SetupScreen"
import { DesktopHeader } from "@/components/DesktopHeader"
import { SessionInfoBar } from "@/components/SessionInfoBar"
import { ChatArea } from "@/components/ChatArea"
import { PendingTurnPreview } from "@/components/PendingTurnPreview"
import { TodoProgressPanel } from "@/components/TodoProgressPanel"
import { UpdateBanner } from "@/components/UpdateBanner"
import { TabBar } from "@/components/TabBar"
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
import { useProcessPanel } from "@/hooks/useProcessPanel"
import { useNewSession } from "@/hooks/useNewSession"
import { useWorktrees } from "@/hooks/useWorktrees"
import { useKillAll } from "@/hooks/useKillAll"
import { useMcpServers } from "@/hooks/useMcpServers"
import { useTodoProgress } from "@/hooks/useTodoProgress"
import { useBackgroundAgents } from "@/hooks/useBackgroundAgents"
import { useSlashSuggestions } from "@/hooks/useSlashSuggestions"
import { usePanelState } from "@/hooks/usePanelState"
import { useAppHandlers } from "@/hooks/useAppHandlers"
import { useSwipeNavigation } from "@/hooks/useSwipeNavigation"
import { useTabState } from "@/hooks/useTabState"
import { useBackgroundTabWatcher } from "@/hooks/useBackgroundTabWatcher"
import { TabProvider, type TabContextValue } from "@/contexts/TabContext"
import { hapticLight } from "@/lib/haptics"
import { detectPendingInteraction, parseSession } from "@/lib/parser"
import { dirNameToPath, shortPath, parseSubAgentPath, projectName } from "@/lib/format"
import { OPEN_SUBAGENT_EVENT } from "@/components/FileChangesPanel/file-change-indicators"
import { FOCUS_FILE_EVENT } from "@/components/FileChangesPanel"
import type { ParsedSession } from "@/lib/types"
import { authFetch } from "@/lib/auth"
import { DEFAULT_EFFORT, getModelOptions, normalizeEffortForAgent } from "@/lib/utils"
import {
  agentKindFromDirName,
  findClaudeProjectDirNameForCwd,
  isCodexDirName,
  projectDirNameForAgent,
} from "@/lib/sessionSource"
import type { AgentKind } from "@/lib/sessionSource"
import { LoginScreen } from "@/components/LoginScreen"
import { useNetworkAuth } from "@/hooks/useNetworkAuth"
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable"
import { HoverRevealPanel } from "@/components/HoverRevealPanel"
import { AppProvider } from "@/contexts/AppContext"
import { DiffFontSizeProvider } from "@/contexts/DiffFontSizeContext"
import { SessionProvider, type SessionContextValue, type SessionChatContextValue } from "@/contexts/SessionContext"
import { PtyProvider } from "@/contexts/PtyContext"

// Lazy-loaded components (only rendered when user opens them)
const BranchModal = lazy(() => import("@/components/BranchModal").then(m => ({ default: m.BranchModal })))
const ConfigBrowser = lazy(() => import("@/components/ConfigBrowser").then(m => ({ default: m.ConfigBrowser })))
const ConfigDialog = lazy(() => import("@/components/ConfigDialog").then(m => ({ default: m.ConfigDialog })))
const ProjectSwitcherModal = lazy(() => import("@/components/ProjectSwitcherModal").then(m => ({ default: m.ProjectSwitcherModal })))
const TeamsDashboard = lazy(() => import("@/components/TeamsDashboard").then(m => ({ default: m.TeamsDashboard })))
const ThemeSelectorModal = lazy(() => import("@/components/ThemeSelectorModal").then(m => ({ default: m.ThemeSelectorModal })))
const WorktreePanel = lazy(() => import("@/components/WorktreePanel").then(m => ({ default: m.WorktreePanel })))
const MobileFileChanges = lazy(() => import("@/components/MobileFileChanges").then(m => ({ default: m.MobileFileChanges })))

const MOBILE_TAB_ORDER = ["sessions", "chat", "stats", "teams"] as const

/** Shared footer for the chat input — ensures consistent max-width in both new and active sessions. */
function SessionInputFooter({ floating, children }: { floating?: boolean, children: React.ReactNode }) {
  if (floating) {
    return (
      <div className="absolute bottom-0 left-0 right-0 z-20 flex justify-center pointer-events-none">
        <div className="w-full max-w-3xl px-3 pt-6 bg-gradient-to-t from-elevation-1 from-80% to-transparent pointer-events-auto">
          {children}
        </div>
      </div>
    )
  }
  return (
    <div className="w-full flex justify-center shrink-0">
      <div className="w-full max-w-3xl px-3">
        {children}
      </div>
    </div>
  )
}

export default function App() {
  const config = useAppConfig()
  const networkAuth = useNetworkAuth()
  const isMobile = useIsMobile()
  const themeCtx = useTheme()
  const [state, dispatch] = useSessionState()

  // Panel/sidebar toggle state
  const panels = usePanelState(state, dispatch)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const chatInputRef = useRef<ChatInputHandle>(null)

  // Stable callbacks
  const handleSidebarTabChange = useCallback(
    (tab: "live" | "browse" | "teams") => dispatch({ type: "SET_SIDEBAR_TAB", tab }),
    [dispatch]
  )
  const handleToggleExpandAll = useCallback(() => dispatch({ type: "TOGGLE_EXPAND_ALL" }), [dispatch])
  const handleSelectProject = useCallback((dirName: string | null) => dispatch({ type: "SET_DASHBOARD_PROJECT", dirName }), [dispatch])

  // Real filesystem path for the pending (pre-created) session.
  // pendingCwd is the authoritative path; dirNameToPath is a lossy fallback.
  const pendingPath = state.pendingCwd ?? (state.pendingDirName ? dirNameToPath(state.pendingDirName) : null)
  const currentAgentKind = state.sessionSource?.agentKind
    ?? agentKindFromDirName(state.sessionSource?.dirName ?? state.pendingDirName ?? null)
  const supportsWorktrees = currentAgentKind === "claude"
  const supportsMcp = currentAgentKind === "claude"

  const slashSuggestions = useSlashSuggestions(state.session?.cwd ?? pendingPath ?? undefined)
  const suggestionsRef = useRef(slashSuggestions.suggestions)
  suggestionsRef.current = slashSuggestions.suggestions

  const handleEditCommand = useCallback((commandName: string) => {
    const match = suggestionsRef.current.find((s) => s.name === commandName)
    dispatch({ type: "OPEN_CONFIG", filePath: match?.filePath })
  }, [dispatch])

  const handleExpandCommand = useCallback(async (commandName: string, args?: string): Promise<string | null> => {
    const match = suggestionsRef.current.find((s) => s.name === commandName)
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
  }, [])

  /** Fire-and-forget POST to an action endpoint with path + dirName resolution. */
  const postAction = useCallback((endpoint: string) => {
    authFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pendingPath || undefined, dirName: state.pendingDirName || undefined }),
    }).catch(() => {})
  }, [pendingPath, state.pendingDirName])

  const handleOpenTerminal = useCallback(() => {
    // Prefer the real cwd; send dirName so the server can resolve authoritatively
    const projectPath = state.session?.cwd ?? pendingPath ?? undefined
    const dirName = state.sessionSource?.dirName ?? state.pendingDirName ?? state.dashboardProject ?? undefined
    if (!projectPath && !dirName) { console.warn("[open-terminal] no project path available"); return }
    authFetch("/api/open-terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, dirName }),
    }).then((res) => {
      if (!res.ok) res.json().then((d) => console.error("[open-terminal]", d.error)).catch(() => {})
    }).catch((err) => console.error("[open-terminal] fetch failed:", err))
  }, [state.session?.cwd, pendingPath, state.sessionSource?.dirName, state.pendingDirName, state.dashboardProject])

  const handleMcpAuth = useCallback((_serverName: string) => {
    const projectPath = state.session?.cwd ?? pendingPath ?? undefined
    const dirName = state.sessionSource?.dirName ?? state.pendingDirName ?? state.dashboardProject ?? undefined
    if (!projectPath && !dirName) return
    authFetch("/api/open-terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, dirName, command: "claude /mcp" }),
    }).catch((err) => console.error("[mcp-auth] open-terminal failed:", err))
  }, [state.session?.cwd, pendingPath, state.sessionSource?.dirName, state.pendingDirName, state.dashboardProject])

  // Process panel state (unified: scripts + tasks + terminals)
  const processPanel = useProcessPanel(state.session?.sessionId)

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

  // Track whether the file changes panel has been collapsed via drag
  const [fileChangesCollapsed, setFileChangesCollapsed] = useState(false)
  const handleFileChangesPanelCollapse = useCallback(() => setFileChangesCollapsed(true), [])
  const handleFileChangesPanelExpand = useCallback(() => setFileChangesCollapsed(false), [])

  // Mobile file changes bottom sheet
  const [showMobileFileChanges, setShowMobileFileChanges] = useState(false)

  // Whether to actually show the file changes panel (toggle on + has changes)
  const showFileChangesPanel = hasFileChanges && panels.showFileChanges

  // Layout mode: stacked (vertical), side-by-side (horizontal), or focused (no file changes)
  type LayoutMode = "stacked" | "side-by-side" | "focused"
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => {
    try { return (localStorage.getItem("claudeview:layout-mode") as LayoutMode) || "stacked" } catch { return "stacked" }
  })
  const handleSetLayoutMode = useCallback((mode: LayoutMode) => {
    setLayoutMode(mode)
    try { localStorage.setItem("claudeview:layout-mode", mode) } catch { /* ignore */ }
  }, [])

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
  const pendingInteractionRef = useRef<ReturnType<typeof detectPendingInteraction>>(null)
  const pendingInteraction = useMemo(() => {
    const next = state.session ? detectPendingInteraction(state.session) : null
    if (JSON.stringify(next) === JSON.stringify(pendingInteractionRef.current)) {
      return pendingInteractionRef.current
    }
    pendingInteractionRef.current = next
    return next
  }, [state.session])

  // Live session streaming — wrapped in startTransition so React can
  // interrupt these low-priority renders to process user interactions (clicks).
  // On reconnect after disconnect, reload the full session to catch missed messages.
  const reconnectHandlerRef = useRef<(() => void) | null>(null)
  const { isLive, sseState, isCompacting } = useLiveSession(state.sessionSource, (updated) => {
    startTransition(() => {
      dispatch({ type: "UPDATE_SESSION", session: updated })
    })
  }, () => reconnectHandlerRef.current?.())

  // Background agents (shared between notifications + StatsPanel)
  const backgroundAgents = useBackgroundAgents(state.session?.cwd ?? null)

  // Permissions management
  const perms = usePermissions()

  // Model override (empty = use session default)
  const [selectedModel, setSelectedModel] = useState("")

  const handleCodexModelRejected = useCallback((rejectedModel: string) => {
    setSelectedModel((current) => current === rejectedModel ? "" : current)
  }, [])

  // Thinking effort level
  const [selectedEffort, setSelectedEffort] = useState(DEFAULT_EFFORT)
  const effectiveEffort = normalizeEffortForAgent(currentAgentKind ?? "claude", selectedEffort)

  // MCP server selection
  const currentCwd = state.session?.cwd ?? pendingPath ?? undefined
  const mcpData = useMcpServers(
    supportsMcp ? currentCwd : undefined,
    supportsMcp ? (currentDirName ?? undefined) : undefined,
    supportsMcp ? state.sessionSource?.fileName ?? undefined : undefined
  )

  useEffect(() => {
    if (!supportsWorktrees && panels.showWorktrees) {
      panels.setShowWorktrees(false)
    }
  }, [supportsWorktrees, panels.showWorktrees, panels.setShowWorktrees])

  // New session creation (lazy — no backend call until first message)
  // Declared before usePtyChat because it provides the onCreateSession callback.
  const sessionFinalizedRef = useRef<((parsed: ParsedSession) => void) | null>(null)
  const liveSessionsRefreshRef = useRef<(() => void) | null>(null)
  const [pendingFirstMessage, setPendingFirstMessage] = useState<string | null>(null)
  const {
    creatingSession,
    createError,
    clearCreateError,
    handleNewSession,
    createAndSend,
    cancelCreation,
    worktreeEnabled,
    setWorktreeEnabled,
    // worktreeName and setWorktreeName omitted — ChatInputSettings only uses the toggle
  } = useNewSession({
    permissionsConfig: perms.config,
    dispatch,
    isMobile,
    onSessionFinalized: (parsed) => {
      sessionFinalizedRef.current?.(parsed)
      // Force Live & Recent to refresh so the new session appears.
      // Two refreshes: one quick to pick up the session early, one later
      // in case the active-sessions API hadn't indexed it yet.
      setTimeout(() => liveSessionsRefreshRef.current?.(), 300)
      setTimeout(() => liveSessionsRefreshRef.current?.(), 2000)
    },
    onCreateStarted: setPendingFirstMessage,
    onCodexModelRejected: handleCodexModelRejected,
    model: selectedModel,
    effort: effectiveEffort,
    mcpConfig: supportsMcp ? mcpData.mcpConfigJson : null,
  })

  const [pendingAgentSource, setPendingAgentSource] = useState<{
    claudeDirName: string
    cwd: string | null
  } | null>(null)
  const claudeProjectDirCacheRef = useRef(new Map<string, string | null>())

  const resolveClaudeProjectDirName = useCallback(async (cwd: string): Promise<string | null> => {
    const cache = claudeProjectDirCacheRef.current
    if (cache.has(cwd)) {
      return cache.get(cwd) ?? null
    }

    try {
      const res = await authFetch("/api/projects")
      if (!res.ok) {
        cache.set(cwd, null)
        return null
      }
      const projects = await res.json() as Array<{ dirName: string; path: string }>
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
      handleNewSession(dirName)
      return
    }

    const claudeDirName = isCodexDirName(dirName)
      ? await resolveClaudeProjectDirName(normalizedCwd)
      : dirName

    setPendingAgentSource(claudeDirName ? { claudeDirName, cwd: normalizedCwd } : null)
    handleNewSession(dirName, normalizedCwd)
  }, [handleNewSession, resolveClaudeProjectDirName])

  const handlePendingSessionAgentChange = useCallback((agentKind: AgentKind) => {
    const pending = pendingAgentSource
    if (!pending?.cwd) return
    const nextDirName = projectDirNameForAgent(pending.claudeDirName, pending.cwd, agentKind)
    handleNewSession(nextDirName, pending.cwd)
  }, [pendingAgentSource, handleNewSession])

  // Build the pending session info for the Live & Recent placeholder
  const pendingSessionInfo = useMemo(() => {
    if (!creatingSession || !state.pendingDirName) return null
    return {
      dirName: state.pendingDirName,
      cwd: state.pendingCwd,
      firstMessage: pendingFirstMessage ?? undefined,
    }
  }, [creatingSession, state.pendingDirName, state.pendingCwd, pendingFirstMessage])

  // Clear pending first message when we leave the pending state
  useEffect(() => {
    if (!state.pendingDirName) {
      setPendingFirstMessage(null)
      setPendingAgentSource(null)
    }
  }, [state.pendingDirName])

  useEffect(() => {
    if (!selectedModel) return
    if (!state.sessionSource && !state.pendingDirName) return
    const options = getModelOptions(currentAgentKind ?? "claude")
    if (!options.some((option) => option.value === selectedModel)) {
      setSelectedModel("")
    }
  }, [currentAgentKind, selectedModel, state.sessionSource, state.pendingDirName])

  // Active agent chat
  const claudeChat = usePtyChat({
    sessionSource: state.sessionSource,
    parsedSessionId: state.session?.sessionId ?? null,
    cwd: state.session?.cwd,
    permissions: perms.config,
    onPermissionsApplied: perms.markApplied,
    model: selectedModel,
    effort: effectiveEffort,
    mcpConfig: supportsMcp ? mcpData.mcpConfigJson : null,
    onCodexModelRejected: handleCodexModelRejected,
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
    pendingMessages: claudeChat.pendingMessages,
    consumePending: claudeChat.consumePending,
    sessionChangeKey: state.sessionChangeKey,
  })

  const chatScrollRef = scroll.chatScrollRef

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

  // Wire up the session finalized ref now that scroll is available
  sessionFinalizedRef.current = (_parsed) => {
    // Reset to 0 so useChatScroll detects "new turns" and clears pendingMessage
    scroll.resetTurnCount(0)
    scroll.scrollToBottomInstant()
  }

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
    onBeforeSwitch: handlePreSessionSwitch,
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
  const pushHistory = sessionHistory.push
  useEffect(() => {
    if (state.sessionSource) {
      pushHistory(state.sessionSource.dirName, state.sessionSource.fileName)
    }
  }, [state.sessionSource, pushHistory])

  // ─── Tab State ────────────────────────────────────────────────────────
  const [tabState, tabDispatch] = useTabState()
  useBackgroundTabWatcher(tabState.tabs, tabState.activeTabId, tabDispatch)

  // Snapshot current tab state before switching away
  const snapshotCurrentTab = useCallback(() => {
    if (!tabState.activeTabId) return
    tabDispatch({
      type: "SNAPSHOT_ACTIVE",
      activeTurnIndex: state.activeTurnIndex,
      activeToolCallId: state.activeToolCallId,
      searchQuery: state.searchQuery,
      expandAll: state.expandAll,
      scrollTop: scroll.chatScrollRef.current?.scrollTop ?? 0,
      session: state.session,
      source: state.sessionSource,
    })
  }, [
    tabState.activeTabId, tabDispatch,
    state.activeTurnIndex, state.activeToolCallId,
    state.searchQuery, state.expandAll,
    state.session, state.sessionSource,
    scroll.chatScrollRef,
  ])

  // Restore a tab snapshot into the session state
  const restoreTabSnapshot = useCallback((tab: typeof tabState.tabs[0]) => {
    handlePreSessionSwitch()
    if (tab.cachedSession && tab.cachedSource) {
      dispatch({
        type: "RESTORE_TAB_SNAPSHOT",
        session: tab.cachedSession,
        source: tab.cachedSource,
        activeTurnIndex: tab.activeTurnIndex,
        activeToolCallId: tab.activeToolCallId,
        searchQuery: tab.searchQuery,
        expandAll: tab.expandAll,
        isMobile,
      })
      scroll.resetTurnCount(tab.cachedSession.turns.length)
      // Restore scroll position after render
      const savedScrollTop = tab.scrollTop
      requestAnimationFrame(() => {
        const el = scroll.chatScrollRef.current
        if (el) el.scrollTop = savedScrollTop
      })
    } else if (tab.pendingDirName) {
      dispatch({
        type: "RESTORE_TAB_SNAPSHOT",
        session: null,
        source: null,
        activeTurnIndex: null,
        activeToolCallId: null,
        searchQuery: "",
        expandAll: false,
        isMobile,
        pendingDirName: tab.pendingDirName,
        pendingCwd: tab.pendingCwd,
      })
    } else if (tab.dirName && tab.fileName) {
      // No cached data — fetch from API
      actions.handleDashboardSelect(tab.dirName, tab.fileName)
    }
  }, [dispatch, isMobile, scroll, handlePreSessionSwitch, actions])

  // Tab switch handler: snapshot current → switch → restore target
  const handleSwitchTab = useCallback((tabId: string) => {
    if (tabId === tabState.activeTabId) return
    const target = tabState.tabs.find(t => t.id === tabId)
    if (!target) return
    snapshotCurrentTab()
    tabDispatch({ type: "SWITCH_TAB", tabId })
    tabDispatch({ type: "CLEAR_ACTIVITY", tabId })
    restoreTabSnapshot(target)
  }, [tabState.activeTabId, tabState.tabs, snapshotCurrentTab, tabDispatch, restoreTabSnapshot])

  // Open session in a new tab
  const handleOpenInNewTabSimple = useCallback(async (dirName: string, fileName: string, label: string) => {
    snapshotCurrentTab()
    const tabId = `${dirName}/${fileName}`
    const existingTab = tabState.tabs.find(t => t.id === tabId)
    if (existingTab) {
      tabDispatch({ type: "SWITCH_TAB", tabId })
      tabDispatch({ type: "CLEAR_ACTIVITY", tabId })
      restoreTabSnapshot(existingTab)
      return
    }
    // Fetch the session first, then open tab with cached data
    handlePreSessionSwitch()
    try {
      const res = await authFetch(
        `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`
      )
      if (!res.ok) return
      const text = await res.text()
      const parsed = parseSession(text)
      const source = { dirName, fileName, rawText: text, agentKind: agentKindFromDirName(dirName) } as const
      const tabLabel = projectName(parsed.cwd || dirNameToPath(dirName))
      tabDispatch({ type: "OPEN_TAB", session: parsed, source: { ...source }, label: tabLabel })
      dispatch({ type: "LOAD_SESSION", session: parsed, source: { ...source }, isMobile })
      scroll.resetTurnCount(parsed.turns.length)
      scroll.scrollToBottomInstant()
    } catch {
      // silently fail
    }
  }, [snapshotCurrentTab, tabState.tabs, tabDispatch, handlePreSessionSwitch, dispatch, isMobile, scroll, restoreTabSnapshot])

  // Close tab handler
  const handleCloseTab = useCallback((tabId: string) => {
    const isActive = tabId === tabState.activeTabId
    const tab = tabState.tabs.find(t => t.id === tabId)
    if (!tab) return

    tabDispatch({ type: "CLOSE_TAB", tabId })

    if (isActive) {
      const idx = tabState.tabs.findIndex(t => t.id === tabId)
      const remaining = tabState.tabs.filter(t => t.id !== tabId)
      if (remaining.length > 0) {
        const nextIdx = Math.min(idx, remaining.length - 1)
        const nextTab = remaining[nextIdx]
        restoreTabSnapshot(nextTab)
      } else {
        dispatch({ type: "GO_HOME", isMobile })
      }
    }
  }, [tabState.activeTabId, tabState.tabs, tabDispatch, restoreTabSnapshot, dispatch, isMobile])

  // Sync: when a session is loaded via normal flow, ensure it has a tab
  // Also update the label if the slug becomes available (e.g. after session loads)
  useEffect(() => {
    if (!state.sessionSource) return
    const tabId = `${state.sessionSource.dirName}/${state.sessionSource.fileName}`
    const label = projectName(state.session?.cwd ?? dirNameToPath(state.sessionSource.dirName))
    const existingTab = tabState.tabs.find(t => t.id === tabId)
    if (!existingTab) {
      tabDispatch({
        type: "OPEN_TAB",
        session: state.session,
        source: state.sessionSource,
        label,
      })
    } else if (existingTab.label !== label) {
      tabDispatch({
        type: "UPDATE_TAB_META",
        tabId,
        updates: { label },
      })
    }
  }, [state.sessionSource, state.session, tabState.tabs, tabDispatch])

  // Tab context value
  const tabContextValue = useMemo<TabContextValue>(() => ({
    tabs: tabState.tabs,
    activeTabId: tabState.activeTabId,
    dispatch: tabDispatch,
    switchTab: handleSwitchTab,
    openInNewTab: handleOpenInNewTabSimple,
    closeTab: handleCloseTab,
  }), [tabState.tabs, tabState.activeTabId, tabDispatch, handleSwitchTab, handleOpenInNewTabSimple, handleCloseTab])

  // App-level handlers (extracted from App.tsx)
  const handlers = useAppHandlers({
    state: { session: state.session, sessionSource: state.sessionSource },
    dispatch,
    isMobile,
    handleJumpToTurn: actions.handleJumpToTurn,
    markPermissionsApplied: perms.markApplied,
    hasPermsPendingChanges: perms.hasPendingChanges,
    selectedModel,
    setSelectedModel,
    selectedEffort: effectiveEffort,
    setSelectedEffort,
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

  // Wire reconnect handler now that reloadSession is available
  reconnectHandlerRef.current = handlers.reloadSession

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
  // Tab cycling for keyboard shortcuts
  const handleNextTab = useCallback(() => {
    if (tabState.tabs.length < 2 || !tabState.activeTabId) return
    const idx = tabState.tabs.findIndex(t => t.id === tabState.activeTabId)
    const nextIdx = (idx + 1) % tabState.tabs.length
    handleSwitchTab(tabState.tabs[nextIdx].id)
  }, [tabState.tabs, tabState.activeTabId, handleSwitchTab])

  const handlePrevTab = useCallback(() => {
    if (tabState.tabs.length < 2 || !tabState.activeTabId) return
    const idx = tabState.tabs.findIndex(t => t.id === tabState.activeTabId)
    const prevIdx = (idx - 1 + tabState.tabs.length) % tabState.tabs.length
    handleSwitchTab(tabState.tabs[prevIdx].id)
  }, [tabState.tabs, tabState.activeTabId, handleSwitchTab])

  const handleCloseCurrentTab = useCallback(() => {
    if (tabState.activeTabId) handleCloseTab(tabState.activeTabId)
  }, [tabState.activeTabId, handleCloseTab])

  useKeyboardShortcuts({
    isMobile,
    searchInputRef,
    chatInputRef,
    dispatch,
    onToggleSidebar: panels.handleToggleSidebar,
    onToggleRightSidebar: panels.handleToggleStats,
    onOpenProjectSwitcher: panels.handleOpenProjectSwitcher,
    onOpenThemeSelector: panels.handleToggleThemeSelector,
    onOpenTerminal: handleOpenTerminal,
    onHistoryBack: sessionHistory.goBack,
    onHistoryForward: sessionHistory.goForward,
    onNavigateToSession: actions.handleDashboardSelect,
    onCommitNavigation: sessionHistory.commitNavigation,
    onNextTab: tabState.tabs.length > 0 ? handleNextTab : undefined,
    onPrevTab: tabState.tabs.length > 0 ? handlePrevTab : undefined,
    onCloseTab: tabState.tabs.length > 0 ? handleCloseCurrentTab : undefined,
  })

  // Kill-all handler
  const { killing, handleKillAll } = useKillAll()

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
    },
  }), [
    state.session, state.sessionSource,
    isLive, sseState, isCompacting,
    undoRedo, pendingInteraction, isSubAgentView,
    slashSuggestions.suggestions, slashSuggestions.loading,
    handlers.handleStopSession, panels.handleEditConfig, handleEditCommand, handleExpandCommand,
    handlers.handleOpenBranches, handlers.handleBranchFromHere, handleToggleExpandAll,
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

  // ─── MOBILE: Swipe navigation between tabs ─────────────────────────────────
  const mobileVisibleTabs = useMemo(() =>
    MOBILE_TAB_ORDER.filter((t) => {
      if (t === "stats" && !state.session && !state.pendingDirName) return false
      if (t === "teams" && !teamContext) return false
      return true
    }),
    [state.session, state.pendingDirName, teamContext],
  )
  const swipeRef = useSwipeNavigation<HTMLElement>({
    enabled: isMobile,
    onSwipeLeft: () => {
      const idx = mobileVisibleTabs.indexOf(state.mobileTab as typeof mobileVisibleTabs[number])
      if (idx < mobileVisibleTabs.length - 1) {
        hapticLight()
        actions.handleMobileTabChange(mobileVisibleTabs[idx + 1])
      }
    },
    onSwipeRight: () => {
      const idx = mobileVisibleTabs.indexOf(state.mobileTab as typeof mobileVisibleTabs[number])
      if (idx > 0) {
        hapticLight()
        actions.handleMobileTabChange(mobileVisibleTabs[idx - 1])
      }
    },
  })

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
      onUpdateStatus={processPanel.updateProcessStatus}
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

  const isNewSession = !!state.pendingDirName && !state.session

  const chatInputNode = (
    <div className="shrink-0 bg-elevation-1">
      <ChatInput ref={chatInputRef} />
      <ChatInputSettings
        agentKind={currentAgentKind ?? "claude"}
        onAgentKindChange={isNewSession && pendingAgentSource?.cwd ? handlePendingSessionAgentChange : undefined}
        selectedModel={selectedModel}
        onModelChange={setSelectedModel}
        selectedEffort={effectiveEffort}
        onEffortChange={setSelectedEffort}
        isNewSession={isNewSession}
        worktreeEnabled={worktreeEnabled}
        onWorktreeEnabledChange={isNewSession && supportsWorktrees ? setWorktreeEnabled : undefined}
        onApplySettings={handlers.handleApplySettings}
        activeModelId={state.session?.model}
        mcpServers={supportsMcp ? mcpData.servers : undefined}
        selectedMcpServers={supportsMcp ? mcpData.selectedServers : undefined}
        onToggleMcpServer={supportsMcp ? mcpData.toggleServer : undefined}
        onRefreshMcpServers={supportsMcp ? mcpData.refresh : undefined}
        mcpLoading={supportsMcp ? mcpData.loading : undefined}
        onMcpAuth={supportsMcp ? handleMcpAuth : undefined}
      />
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
      <DiffFontSizeProvider>
      <PtyProvider>
      <SessionProvider value={sessionContextValue} chatValue={sessionChatValue}>
      <div className={`${themeCtx.themeClasses} flex h-dvh flex-col bg-elevation-0 text-foreground`}>
        {backgroundServers}
        <UpdateBanner />
        <main ref={swipeRef} className="flex flex-1 min-h-0 overflow-hidden">
          {state.mobileTab === "sessions" && (
            <SessionBrowser
              sessionId={state.session?.sessionId ?? null}
              activeSessionKey={activeSessionKey}
              onLoadSession={actions.handleLoadSession}
              sidebarTab={state.sidebarTab}
              onSidebarTabChange={handleSidebarTabChange}
              onSelectTeam={actions.handleSelectTeam}
              onNewSession={handleStartNewSession}
              creatingSession={creatingSession}
              pendingSession={pendingSessionInfo}
              onDuplicateSession={handlers.handleDuplicateSessionByPath}
              onDeleteSession={handlers.handleDeleteSession}
              onBeforeSessionSwitch={handlePreSessionSwitch}
              liveSessionsRefreshRef={liveSessionsRefreshRef}
              isMobile
            />
          )}

          {state.mobileTab === "chat" && (
            <div className="flex flex-1 min-h-0 flex-col min-w-0">
              {state.mainView === "teams" && state.selectedTeam ? (
                <Suspense fallback={null}>
                  <TeamsDashboard
                    teamName={state.selectedTeam}
                    onBack={actions.handleBackFromTeam}
                    onOpenSession={actions.handleOpenSessionFromTeam}
                  />
                </Suspense>
              ) : state.session ? (
                <div className="flex flex-1 min-h-0 flex-col">
                  {teamMembersBar}
                  <SessionInfoBar
                    creatingSession={creatingSession}
                    onNewSession={handleStartNewSession}
                    onDuplicateSession={handlers.handleDuplicateSession}
                    onOpenTerminal={handleOpenTerminal}
                    onBackToMain={isSubAgentView ? handleBackToMain : undefined}
                    onShowFileChanges={() => setShowMobileFileChanges(true)}
                    hasFileChanges={hasFileChanges}
                  />
                  <ChatArea searchInputRef={searchInputRef} />
                </div>
              ) : state.pendingDirName ? (
                <div className="flex flex-1 min-h-0 flex-col">
                  {pendingPreviewList.length > 0 ? (
                    <div className="flex-1 overflow-y-auto px-1 py-3">
                      {pendingPreviewList}
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
                  onNewSession={handleStartNewSession}
                  creatingSession={creatingSession}
                  selectedProjectDirName={state.dashboardProject}
                  onSelectProject={handleSelectProject}
                  onDuplicateSession={handlers.handleDuplicateSessionByPath}
                  onDeleteSession={handlers.handleDeleteSession}
                />
              )}
            </div>
          )}

          {state.mobileTab === "stats" && state.session && (
            <StatsPanel
              onJumpToTurn={handlers.handleMobileJumpToTurn}
              onToggleServer={processPanel.handleToggleServer}
              onServersChanged={processPanel.handleServersChanged}
              onLoadSession={handlers.handleLoadSessionScrollAware}
              backgroundAgents={backgroundAgents}
            />
          )}

          {state.mobileTab === "teams" && (
            <div className="flex flex-1 min-h-0 flex-col min-w-0">
              {state.selectedTeam ? (
                <Suspense fallback={null}>
                  <TeamsDashboard
                    teamName={state.selectedTeam}
                    onBack={actions.handleBackFromTeam}
                    onOpenSession={actions.handleOpenSessionFromTeam}
                  />
                </Suspense>
              ) : (
                <SessionBrowser
                  sessionId={state.session?.sessionId ?? null}
                  activeSessionKey={activeSessionKey}
                  onLoadSession={actions.handleLoadSession}
                  sidebarTab="teams"
                  onSidebarTabChange={handleSidebarTabChange}
                  onSelectTeam={actions.handleSelectTeam}
                  isMobile
                  teamsOnly
                  onBeforeSessionSwitch={handlePreSessionSwitch}
                />
              )}
            </div>
          )}
        </main>

        {processPanelNode}
        {state.mobileTab === "chat" && (state.session || state.pendingDirName) && state.mainView !== "teams" && (
          <>
            {todoProgress && <TodoProgressPanel progress={todoProgress} />}
            {subAgentReadOnlyNode || chatInputNode}
          </>
        )}

        <MobileNav
          activeTab={state.mobileTab}
          onTabChange={actions.handleMobileTabChange}
          hasTeam={!!teamContext}
          hasFileChanges={hasFileChanges}
          onShowFileChanges={() => setShowMobileFileChanges(true)}
        />

        {undoConfirmDialog}
        {branchModal}
        {errorToast || sseIndicator}
        {state.session && (
          <Suspense fallback={null}>
            <MobileFileChanges
              open={showMobileFileChanges}
              onClose={() => setShowMobileFileChanges(false)}
              session={state.session}
              sessionChangeKey={state.sessionChangeKey}
            />
          </Suspense>
        )}
      </div>
      </SessionProvider>
      </PtyProvider>
      </DiffFontSizeProvider>
      </AppProvider>
    )
  }

  // ─── DESKTOP LAYOUT ─────────────────────────────────────────────────────────
  return (
    <AppProvider value={appContextValue}>
    <DiffFontSizeProvider>
    <PtyProvider>
    <TabProvider value={tabContextValue}>
    <SessionProvider value={sessionContextValue} chatValue={sessionChatValue}>
    <div className={`${themeCtx.themeClasses} flex h-dvh flex-col bg-elevation-0 text-foreground`}>
      {backgroundServers}
      <UpdateBanner />
      <DesktopHeader
        showSidebar={panels.showSidebar}
        showStats={panels.showStats}
        showWorktrees={supportsWorktrees && panels.showWorktrees}
        showFileChanges={panels.showFileChanges}
        hasFileChanges={hasFileChanges}
        killing={killing}
        onGoHome={actions.handleGoHome}
        onToggleSidebar={panels.handleToggleSidebar}
        onToggleStats={panels.handleToggleStats}
        onToggleWorktrees={supportsWorktrees ? panels.handleToggleWorktrees : undefined}
        onToggleFileChanges={panels.handleToggleFileChanges}
        showConfig={state.mainView === "config"}
        onToggleConfig={panels.handleToggleConfig}
        onKillAll={handleKillAll}
        onOpenSettings={config.openConfigDialog}
        layoutMode={layoutMode}
        onSetLayoutMode={handleSetLayoutMode}
      />

      <TabBar
        tabs={tabState.tabs}
        activeTabId={tabState.activeTabId}
        onSwitchTab={handleSwitchTab}
        onCloseTab={handleCloseTab}
        onNewTab={() => {
          snapshotCurrentTab()
          dispatch({ type: "GO_HOME", isMobile })
        }}
      />

      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        <HoverRevealPanel
          side="left"
          visible={panels.showSidebar && state.mainView !== "config"}
          enabled={state.mainView !== "config"}
        >
          <SessionBrowser
            sessionId={state.session?.sessionId ?? null}
            activeSessionKey={activeSessionKey}
            onLoadSession={actions.handleLoadSession}
            onOpenInNewTab={handleOpenInNewTabSimple}
            sidebarTab={state.sidebarTab}
            onSidebarTabChange={handleSidebarTabChange}
            onSelectTeam={actions.handleSelectTeam}
            onNewSession={handleStartNewSession}
            creatingSession={creatingSession}
            pendingSession={pendingSessionInfo}
            onDuplicateSession={handlers.handleDuplicateSessionByPath}
            onDeleteSession={handlers.handleDeleteSession}
            onBeforeSessionSwitch={handlePreSessionSwitch}
            liveSessionsRefreshRef={liveSessionsRefreshRef}
            projectDir={state.session?.cwd ?? state.pendingCwd ?? null}
            onScriptStarted={processPanel.addProcess}
          />
        </HoverRevealPanel>

        <main className="relative flex-1 min-w-0 overflow-hidden flex flex-col">
          {state.mainView === "config" ? (
            <Suspense fallback={null}>
              <ConfigBrowser
                projectPath={
                  state.session?.cwd
                  ?? pendingPath
                  ?? (state.sessionSource?.dirName ? dirNameToPath(state.sessionSource.dirName) : null)
                  ?? (state.dashboardProject ? dirNameToPath(state.dashboardProject) : null)
                }
                initialFilePath={state.configFilePath}
              />
            </Suspense>
          ) : state.mainView === "teams" && state.selectedTeam ? (
            <Suspense fallback={null}>
              <TeamsDashboard
                teamName={state.selectedTeam}
                onBack={actions.handleBackFromTeam}
                onOpenSession={actions.handleOpenSessionFromTeam}
              />
            </Suspense>
          ) : state.session ? (
            <div className="flex flex-col flex-1 min-h-0">
              <ResizablePanelGroup
                orientation={layoutMode === "side-by-side" ? "horizontal" : "vertical"}
                className="flex-1 min-h-0"
              >
                <ResizablePanel
                  defaultSize={showFileChangesPanel && layoutMode !== "focused" ? (layoutMode === "side-by-side" ? 55 : 60) : 100}
                  minSize={layoutMode === "side-by-side" ? 30 : 25}
                >
                  <div className="relative h-full min-h-0 flex flex-col">
                    {teamMembersBar}
                    <SessionInfoBar
                      creatingSession={creatingSession}
                      onNewSession={handleStartNewSession}
                      onDuplicateSession={handlers.handleDuplicateSession}
                      onOpenTerminal={handleOpenTerminal}
                      onBackToMain={isSubAgentView ? handleBackToMain : undefined}
                    />
                    <ChatArea searchInputRef={searchInputRef} hasTodos={!!todoProgress && todosExpanded} />
                    {todoProgress && (
                      <div className="shrink-0 border-t border-border/30">
                        <TodoProgressPanel progress={todoProgress} expanded={todosExpanded} onExpandedChange={handleTodosExpandedChange} />
                      </div>
                    )}
                  </div>
                </ResizablePanel>

                {showFileChangesPanel && layoutMode !== "focused" && (
                  <>
                    <ResizableHandle withHandle />
                    <ResizablePanel
                      defaultSize={layoutMode === "side-by-side" ? 45 : 40}
                      minSize={0}
                      collapsible
                      onCollapse={handleFileChangesPanelCollapse}
                      onExpand={handleFileChangesPanelExpand}
                    >
                      {!fileChangesCollapsed && (
                        <FileChangesPanel session={state.session} sessionChangeKey={state.sessionChangeKey} />
                      )}
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>
            </div>
          ) : state.pendingDirName ? (
            <div className="flex flex-1 min-h-0 flex-col min-w-0">
              {pendingPreviewList.length > 0 ? (
                <div className="flex-1 overflow-y-auto px-4 py-6">
                  <div className="mx-auto max-w-3xl">
                    {pendingPreviewList}
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
                      onClick={() => postAction("/api/open-in-editor")}
                    >
                      <Code2 className="size-3" />
                      Open
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 gap-1.5 text-[11px] text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10"
                      onClick={() => postAction("/api/reveal-in-folder")}
                    >
                      <FolderSearch className="size-3" />
                      Reveal
                    </Button>
                  </div>
                </div>
              )}
              <SessionInputFooter>{chatInputNode}</SessionInputFooter>
            </div>
          ) : (
            <Dashboard
              onSelectSession={actions.handleDashboardSelect}
              onNewSession={handleStartNewSession}
              creatingSession={creatingSession}
              selectedProjectDirName={state.dashboardProject}
              onSelectProject={handleSelectProject}
              onDuplicateSession={handlers.handleDuplicateSessionByPath}
              onDeleteSession={handlers.handleDeleteSession}
            />
          )}
        </main>

        <HoverRevealPanel
          side="right"
          visible={panels.showStats && !!state.session && state.mainView !== "teams" && state.mainView !== "config"}
          enabled={!!state.session && state.mainView !== "teams" && state.mainView !== "config"}
        >
          <StatsPanel
            onJumpToTurn={actions.handleJumpToTurn}
            onToggleServer={processPanel.handleToggleServer}
            onServersChanged={processPanel.handleServersChanged}
            searchInputRef={searchInputRef}
            onLoadSession={handlers.handleLoadSessionScrollAware}
            backgroundAgents={backgroundAgents}
          />
        </HoverRevealPanel>

      </div>

      <Suspense fallback={null}>
        <WorktreePanel
          open={supportsWorktrees && panels.showWorktrees}
          onOpenChange={panels.setShowWorktrees}
          worktrees={worktreeData.worktrees}
          loading={worktreeData.loading}
          dirName={currentDirName}
          onRefetch={worktreeData.refetch}
          onOpenSession={(sessionId) => {
            // sessionId is a JSONL filename without extension; navigate to it
            if (currentDirName) {
              actions.handleDashboardSelect(currentDirName, `${sessionId}.jsonl`)
            }
            panels.setShowWorktrees(false)
          }}
        />
      </Suspense>

      {processPanelNode}
      {undoConfirmDialog}
      {branchModal}

      <Suspense fallback={null}>
        <ConfigDialog
          open={config.showConfigDialog}
          currentPath={config.claudeDir ?? ""}
          onClose={config.handleCloseConfigDialog}
          onSaved={config.handleConfigSaved}
        />
      </Suspense>

      <Suspense fallback={null}>
        <ProjectSwitcherModal
          open={panels.showProjectSwitcher}
          onClose={panels.handleCloseProjectSwitcher}
          onNewSession={handleStartNewSession}
          currentProjectDirName={state.sessionSource?.dirName ?? state.pendingDirName ?? null}
          currentProjectCwd={state.session?.cwd ?? state.pendingCwd ?? null}
        />
      </Suspense>

      <Suspense fallback={null}>
        <ThemeSelectorModal
          open={panels.showThemeSelector}
          onClose={panels.handleCloseThemeSelector}
          currentTheme={themeCtx.theme}
          onSelectTheme={themeCtx.setTheme}
          onPreviewTheme={themeCtx.setPreview}
        />
      </Suspense>

      {errorToast || sseIndicator}
    </div>
    </SessionProvider>
    </TabProvider>
    </PtyProvider>
    </DiffFontSizeProvider>
    </AppProvider>
  )
}
