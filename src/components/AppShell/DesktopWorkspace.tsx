import { WorktreeStartupStatus } from "@/components/WorktreeStartupStatus"
import { resolvePluginPanelPreference } from "@/plugins/panelAliases"
import { useOpenSessionCrew } from "@/hooks/useOpenSessionCrew"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Code2, FolderSearch, LayoutGrid, PanelLeftClose, TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DisabledHint } from "@/components/ui/disabled-hint"
import { AppDock } from "@/components/AppDock"
import { ChatArea } from "@/components/ChatArea"
import { StickyPromptSlot } from "@/components/StickyPromptBanner"
import { FloatingChrome } from "@/components/FloatingChrome"
import { HeaderIconButton } from "@/components/header-shared"
import { TodoProgressPanel } from "@/components/TodoProgressPanel"
import { DesktopWorkspacePanels } from "@/components/workspace-panels/DesktopWorkspacePanels"
import { StatusPanelProvider } from "@/components/board/StatusPanelContext"
import { ViewPanelProvider } from "@/components/views/ViewPanelContext"
import { availableWorkspacePanels } from "@/components/workspace-panels/WorkspaceActivityBar"
import { useAppContext } from "@/contexts/AppContext"
import { useOpenSession, useSessionControls } from "@/contexts/SessionContext"
import type { EditionMainView } from "@/edition/contract"
import { useMainView } from "@/edition/hooks"
import { useCan } from "@/hooks/useCapability"
import { useIsRemoteDevice } from "@/contexts/DevicePaneContext"
import { isBuiltInEditorEnabled, openProject, revealInFolder } from "@/lib/fileOpener"
import { dirNameToPath } from "@/lib/format"
import { shortcutLabel } from "@/lib/keybindings"
import { cn } from "@/lib/utils"
import { BUILT_IN_WORKSPACE_PANEL_IDS } from "@/plugins/builtInPanelIds"
import type { ProjectPromptContext, WorkspacePanelContext } from "@/plugin-api"
import type { ComposerAttachment, ComposerContextItem } from "../../../shared/session/composerContext"
import { useRuntimePlugins } from "@/plugins/useRuntimePlugins"
import { RuntimePluginContributions } from "@/plugins/RuntimePluginContributions"
import { useRuntimeWorkspacePanels } from "@/plugins/runtimeWorkspacePanels"
import { SessionInputFooter } from "./SessionInputFooter"
import { NewSessionHeadline } from "./NewSessionHero"
import {
  ExtensionMainView,
  PrimarySessionBrowser,
  LazyViewFallback,
  MissionControlView,
} from "./SharedAppViews"
import {
  projectContextItem,
  resolveDesktopMainView,
  resolveDesktopProjectPath,
} from "./desktopView"
import type { DesktopMainView } from "./desktopView"
import type { DesktopAppShellProps } from "./desktopTypes"
import type { WorktreeSessionRef } from "../../../shared/contracts/worktrees"

const ConfigBrowser = lazy(() => import("@/components/ConfigBrowser").then((module) => ({ default: module.ConfigBrowser })))
const PreviewPanel = lazy(() => import("@/components/PreviewPanel").then((module) => ({ default: module.PreviewPanel })))
const PluginsDialog = lazy(() => import("@/plugins/PluginsDialog").then((module) => ({ default: module.PluginsDialog })))

type DesktopViewProps = Pick<
  DesktopAppShellProps,
  "navigation" | "sessionView" | "project"
>

function DesktopSessionContent({
  sessionView,
  floatingChrome,
}: Pick<DesktopAppShellProps, "sessionView"> & { floatingChrome: ReactNode }) {
  const hasSession = useOpenSession((open) => open !== null)
  if (!hasSession) return null

  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {floatingChrome}
        {sessionView.teamMembersBar && (
          <div className="pt-10">{sessionView.teamMembersBar}</div>
        )}
        <ChatArea
          searchInputRef={sessionView.searchInputRef}
          hasTodos={Boolean(sessionView.todoProgress) && sessionView.todosExpanded}
          hasMore={sessionView.hasMoreTurns}
          isLoadingOlder={sessionView.isLoadingOlderTurns}
          onLoadMore={sessionView.onLoadMoreTurns}
        />
        <SessionInputFooter floating>
          {sessionView.todoProgress && (
            <TodoProgressPanel
              progress={sessionView.todoProgress}
              expanded={sessionView.todosExpanded}
              onExpandedChange={sessionView.onTodosExpandedChange}
            />
          )}
          {sessionView.activeComposer}
        </SessionInputFooter>
      </div>
    </div>
  )
}

function DesktopMainView({
  navigation,
  sessionView,
  project,
  view,
  extensionView,
  floatingChrome,
}: DesktopViewProps & { view: DesktopMainView; extensionView: EditionMainView | null; floatingChrome: ReactNode }) {
  const can = useCan()
  const { state, config } = useAppContext()
  const { sessionSource } = useSessionControls()
  const sessionCwd = useOpenSession((open) => open?.cwd)
  const remoteDevice = useIsRemoteDevice()
  const pendingPath = state.pendingCwd
    ?? (state.pendingDirName ? dirNameToPath(state.pendingDirName) : null)

  if (view === "config") {
    return (
      <Suspense fallback={<LazyViewFallback label="Loading configuration…" />}>
        <div className="motion-session-enter flex min-h-0 flex-1 pt-10">
          <ConfigBrowser
            projectPath={resolveDesktopProjectPath({
              sessionCwd,
              pendingPath,
              sessionDirPath: sessionSource?.dirName ? dirNameToPath(sessionSource.dirName) : null,
              dashboardProjectPath: state.dashboardProject ? dirNameToPath(state.dashboardProject) : null,
            })}
            initialFilePath={state.configFilePath}
          />
        </div>
      </Suspense>
    )
  }

  if (view === "mission") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <MissionControlView navigation={navigation} />
      </div>
    )
  }

  if (view === "extension" && extensionView) {
    return (
      <div className="flex min-h-0 flex-1 flex-col pt-10">
        <ExtensionMainView view={extensionView} onClose={navigation.panels.closeMainView} />
      </div>
    )
  }

  if (view === "session") {
    return (
      <DesktopSessionContent
        sessionView={sessionView}
        floatingChrome={floatingChrome}
      />
    )
  }

  if (view === "pending") {
    const hasPendingTurns = sessionView.pendingTurns.length > 0
    // These reach into the host filesystem, so they stay visible but explain
    // themselves when the active device is somewhere else.
    const hostActionReason = remoteDevice
      ? "Only on the machine running this session"
      : undefined
    // The built-in workspace reads the remote device's files over the proxy, so
    // it is the one host action that still works from another machine.
    const editorActionReason = isBuiltInEditorEnabled() ? undefined : hostActionReason
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          // Before the first message there is no transcript to sit above, so the
          // composer becomes the page instead of hugging the bottom edge.
          !hasPendingTurns && "justify-center gap-4",
        )}
      >
        {hasPendingTurns ? (
          <div className="flex-1 overflow-y-auto px-4 pb-6 pt-14">
            <div className="mx-auto w-full max-w-[var(--chat-width)]">
              {sessionView.pendingTurns}
            </div>
          </div>
        ) : (
          <NewSessionHeadline
            projectPath={pendingPath}
            switcher={{
              onNewSession: navigation.onStartNewSession,
              onNewFolder: navigation.onStartNewFolder,
              defaultAgentKind: config.defaultAgentKind,
            }}
          />
        )}
        {hasPendingTurns && <WorktreeStartupStatus projectCwd={pendingPath} />}
        <SessionInputFooter>{sessionView.pendingComposer}</SessionInputFooter>
        {!hasPendingTurns && (
          <div className="flex items-center justify-center gap-2">
            {can("terminal") && (
              <DisabledHint reason={hostActionReason}>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={Boolean(hostActionReason)}
                  onClick={project.onOpenTerminal}
                >
                  <TerminalSquare data-icon="inline-start" />
                  Terminal
                </Button>
              </DisabledHint>
            )}
            {can("hostFiles") && (
              <>
                <DisabledHint reason={editorActionReason}>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={Boolean(editorActionReason)}
                    onClick={() => openProject(project.pendingProject)}
                  >
                    <Code2 data-icon="inline-start" />
                    Open in editor
                  </Button>
                </DisabledHint>
                <DisabledHint reason={hostActionReason}>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={Boolean(hostActionReason)}
                    onClick={() => revealInFolder(project.pendingProject)}
                  >
                    <FolderSearch data-icon="inline-start" />
                    Reveal in files
                  </Button>
                </DisabledHint>
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  return <MissionControlView navigation={navigation} showProjectHistory />
}

export function DesktopWorkspace({
  navigation,
  sessionView,
  project,
  chrome,
}: DesktopAppShellProps) {
  const can = useCan()
  const { state, config } = useAppContext()
  const { sessionSource } = useSessionControls()
  const sessionId = useOpenSession((open) => open?.sessionId ?? null)
  const openCrew = useOpenSessionCrew(sessionId)
  const [pluginsOpen, setPluginsOpen] = useState(() => new URLSearchParams(window.location.search).get("pluginSafeMode") === "1")
  const [pluginSettingsId, setPluginSettingsId] = useState<string>()
  const [promptSlot, setPromptSlot] = useState<HTMLElement | null>(null)
  const openPluginSettings = useCallback((pluginId: string) => { setPluginSettingsId(pluginId); setPluginsOpen(true) }, [])
  const runtimePlugins = useRuntimePlugins(can("configWrite"))
  const workspacePanels = useRuntimeWorkspacePanels({ ...runtimePlugins, projectPath: project.currentCwd ?? null, openSettings: openPluginSettings })
  const extensionView = useMainView(state.mainView === "extension" ? state.extensionViewId : null)

  function composePrompt(text: string): void {
    const current = sessionView.chatInputRef.current?.getText().trimEnd() ?? ""
    sessionView.chatInputRef.current?.setText(current ? `${current}\n\n${text}\n` : `${text}\n`)
    sessionView.chatInputRef.current?.focus()
  }

  function addProjectContext(value: ProjectPromptContext): void {
    const item = projectContextItem(value)
    if (!item) {
      composePrompt(`@${value.path}`)
      return
    }
    sessionView.chatInputRef.current?.addContext(item)
    sessionView.chatInputRef.current?.focus()
  }

  function addComposerContext(item: ComposerContextItem, attachments?: ComposerAttachment[]): string | null {
    const input = sessionView.chatInputRef.current
    if (!input) return "Open a session or start a new one to add context"
    const refusal = input.addContext(item, attachments)
    input.focus()
    return refusal
  }

  const view = resolveDesktopMainView({
    mainView: state.mainView,
    hasSession: sessionId !== null,
    pendingDirName: state.pendingDirName,
    extensionViewAvailable: extensionView !== null,
  })

  const hideSidebar = (
    <HeaderIconButton
      icon={PanelLeftClose}
      label={`Hide sidebar (${shortcutLabel("toggleSidebar")})`}
      onClick={navigation.panels.handleToggleSidebar}
      size="default"
      className="shrink-0 text-muted-foreground hover:text-foreground"
    />
  )

  const isHome = view === "mission" || (view === "dashboard" && !state.dashboardProject)
  const visitedCrews = useRef(new Set<string>())
  const openWorkspacePanel = navigation.panels.openWorkspacePanel
  useEffect(() => {
    if (isHome || !openCrew || visitedCrews.current.has(openCrew.rootId)) return
    visitedCrews.current.add(openCrew.rootId)
    openWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.crew)
  }, [isHome, openCrew, openWorkspacePanel])
  const sidebarRendered = navigation.panels.showSidebar && state.mainView !== "config" && !isHome

  const panelContext: WorkspacePanelContext = {
    sessionId,
    sessionAddress: sessionSource ? { dirName: sessionSource.dirName, fileName: sessionSource.fileName } : null,
    sessionChangeKey: state.sessionChangeKey,
    projectPath: project.currentCwd ?? null,
    hasFileChanges: project.hasFileChanges,
    canAccessHostFiles: can("hostFiles"),
    canUseBrowser: can("browser"),
    supportsWorktrees: project.supportsWorktrees,
    openSession: navigation.handlers.handleLoadSessionScrollAware,
    composePrompt,
    addFileContext: (value) => {
      const item = projectContextItem(value)
      return item ? addComposerContext(item) : "The reference has no text to add"
    },
    crew: openCrew,
  }
  const visiblePanels = availableWorkspacePanels(workspacePanels, panelContext)
  const activePanel = state.mainView === "sessions" && !isHome
    ? resolvePluginPanelPreference(navigation.panels.activeWorkspacePanel, visiblePanels)
    : null
  const worktreeDirName = sessionSource?.dirName
    ?? state.pendingDirName
    ?? state.dashboardProject
    ?? null

  function toggleWorkspacePanel(panelId: string): void {
    if (project.showPreview) project.onCloseRightWorkspace()
    navigation.panels.toggleWorkspacePanel(panelId)
  }

  function revealViewPanel(): void {
    if (project.showPreview) project.onCloseRightWorkspace()
    openWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.library)
  }

  function revealStatusPanel(): void {
    if (project.showPreview) project.onCloseRightWorkspace()
    openWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.status)
  }

  function openWorktreeSession(session: WorktreeSessionRef): void {
    navigation.actions.handleDashboardSelect(session.dirName, `${session.sessionId}.jsonl`)
    navigation.panels.closeWorkspacePanel()
  }

  const floatingChrome = (
    <FloatingChrome
      showSidebar={navigation.panels.showSidebar}
      sidebarRendered={sidebarRendered}
      sidebarShortcut={shortcutLabel("toggleSidebar")}
      creatingSession={navigation.creatingSession}
      onNewSession={navigation.onStartNewSession}
      onDuplicateSession={navigation.handlers.handleDuplicateSession}
      onOpenTerminal={project.onOpenTerminal}
      onBackToMain={sessionView.onBackToMain}
      onShowWorkflows={sessionView.onShowWorkflows}
      workflowCount={sessionView.workflowCount}
      onToggleSidebar={navigation.panels.handleToggleSidebar}
      promptSlotRef={setPromptSlot}
      showSession={view === "session"}
    />
  )

  return (
    <RuntimePluginContributions runtime={runtimePlugins} workspacePath={project.currentCwd ?? null}>
    <ViewPanelProvider shown={activePanel?.id === BUILT_IN_WORKSPACE_PANEL_IDS.library} onReveal={revealViewPanel}>
    <StatusPanelProvider openSessionId={sessionId} onReveal={revealStatusPanel}>
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {sidebarRendered && (
        <div className="view-transition-sidebar panel-enter w-80 shrink-0 border-r bg-sidebar text-sidebar-foreground">
          <PrimarySessionBrowser navigation={navigation} headerActions={hideSidebar} />
        </div>
      )}

      <DesktopWorkspacePanels
        panels={visiblePanels}
        context={panelContext}
        activePanel={activePanel ?? null}
        services={{
          projectFilesRoot: project.projectFilesRoot ?? project.currentCwd ?? null,
          projectFilesRequest: project.projectFilesRequest,
          backgroundAgents: project.backgroundAgents,
          searchInputRef: sessionView.searchInputRef,
          addProjectContext,
          addComposerContext,
          jumpToTurn: navigation.actions.handleJumpToTurn,
          toggleServer: project.processPanel.handleToggleServer,
          serversChanged: project.processPanel.handleServersChanged,
          loadSession: navigation.handlers.handleLoadSessionScrollAware,
          worktrees: project.worktrees,
          worktreeDirName,
          openWorktreeSession,
        }}
        onClosePanel={navigation.panels.closeWorkspacePanel}
        onTogglePanel={toggleWorkspacePanel}
        actions={[
          {
            id: "mission-control",
            title: "Mission Control",
            icon: LayoutGrid,
            active: isHome,
            onSelect: navigation.panels.handleToggleMission,
          },
        ]}
        railFooter={(
          <AppDock
            killing={chrome.killing}
            onKillAll={chrome.onKillAll}
            onOpenSettings={config.openConfigDialog}
            onOpenCommandPalette={chrome.onOpenCommandPalette}
            onOpenKeyboardShortcuts={() => chrome.onKeyboardShortcutsOpenChange(true)}
            onOpenPlugins={() => setPluginsOpen(true)}
            onOpenAgentFiles={navigation.panels.handleToggleConfig}
            onToggleTerminal={can("terminal") ? project.onToggleIntegratedTerminal : undefined}
            terminalShortcut={shortcutLabel("integratedTerminal")}
            onLogout={chrome.onLogout}
            onOpenMainView={navigation.panels.openMainView}
          />
        )}
      >
        <main className="app-view-transition relative flex size-full min-w-0 flex-col overflow-hidden">
          {view !== "session" && floatingChrome}
          <StickyPromptSlot.Provider value={promptSlot}>
            <DesktopMainView
              navigation={navigation}
              sessionView={sessionView}
              project={project}
              view={view}
              extensionView={extensionView}
              floatingChrome={floatingChrome}
            />
          </StickyPromptSlot.Provider>
        </main>
      </DesktopWorkspacePanels>

      {project.showPreview && project.currentCwd && (
        <Suspense fallback={null}>
          <PreviewPanel cwd={project.currentCwd} onClose={project.onCloseRightWorkspace} />
        </Suspense>
      )}

      {pluginsOpen && can("configWrite") && <Suspense fallback={null}>
        <PluginsDialog client={runtimePlugins.client} state={runtimePlugins} currentPath={project.currentCwd ?? null} initialPluginId={pluginSettingsId} onClose={() => { setPluginsOpen(false); setPluginSettingsId(undefined) }} />
      </Suspense>}

    </div>
    </StatusPanelProvider>
    </ViewPanelProvider>
    </RuntimePluginContributions>
  )
}
