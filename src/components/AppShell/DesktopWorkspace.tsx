import { lazy, Suspense } from "react"
import type { ReactNode } from "react"
import { Code2, FolderSearch, LayoutGrid, SlidersHorizontal, TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DisabledHint } from "@/components/ui/disabled-hint"
import { ChatArea } from "@/components/ChatArea"
import { FloatingChrome } from "@/components/FloatingChrome"
import { SidebarHeader } from "@/components/SidebarHeader"
import { TodoProgressPanel } from "@/components/TodoProgressPanel"
import { DesktopWorkspacePanels } from "@/components/workspace-panels/DesktopWorkspacePanels"
import { availableWorkspacePanels } from "@/components/workspace-panels/WorkspaceActivityBar"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { can } from "@/lib/capabilities"
import { isRemoteDeviceActive } from "@/lib/device"
import { isBuiltInEditorEnabled, openProject, revealInFolder } from "@/lib/fileOpener"
import { dirNameToPath } from "@/lib/format"
import { shortcutLabel } from "@/lib/keybindings"
import { cn } from "@/lib/utils"
import type { ProjectPromptContext, WorkspacePanelContext } from "@/plugin-api"
import { workspacePanels } from "@/plugins/registry"
import { SessionInputFooter } from "./SessionInputFooter"
import { NewSessionHeadline } from "./NewSessionHero"
import {
  PrimarySessionBrowser,
  LazyViewFallback,
  MissionControlView,
  ProjectDashboard,
} from "./SharedAppViews"
import {
  formatProjectPromptContext,
  resolveDesktopMainView,
  resolveDesktopProjectPath,
} from "./desktopView"
import type { DesktopMainView } from "./desktopView"
import type { DesktopAppShellProps } from "./desktopTypes"

const ConfigBrowser = lazy(() => import("@/components/ConfigBrowser").then((module) => ({ default: module.ConfigBrowser })))
const PreviewPanel = lazy(() => import("@/components/PreviewPanel").then((module) => ({ default: module.PreviewPanel })))

type DesktopViewProps = Pick<
  DesktopAppShellProps,
  "navigation" | "sessionView" | "project"
>

function DesktopSessionContent({
  sessionView,
  floatingChrome,
}: Pick<DesktopAppShellProps, "sessionView"> & { floatingChrome: ReactNode }) {
  const { session } = useSessionContext()
  if (!session) return null

  return (
    <div className="flex min-h-0 flex-1 bg-background">
      <div className="relative flex h-full min-h-0 flex-1 flex-col">
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
  floatingChrome,
}: DesktopViewProps & { view: DesktopMainView; floatingChrome: ReactNode }) {
  const { state } = useAppContext()
  const { session, sessionSource } = useSessionContext()
  const pendingPath = state.pendingCwd
    ?? (state.pendingDirName ? dirNameToPath(state.pendingDirName) : null)

  if (view === "config") {
    return (
      <Suspense fallback={<LazyViewFallback label="Loading configuration…" />}>
        <div className="motion-session-enter flex min-h-0 flex-1 pt-10">
          <ConfigBrowser
            projectPath={resolveDesktopProjectPath({
              sessionCwd: session?.cwd,
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
      <div className="flex min-h-0 flex-1 flex-col pt-10">
        <MissionControlView navigation={navigation} />
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
    const hostActionReason = isRemoteDeviceActive()
      ? "Only on the machine running this session"
      : undefined
    // The built-in workspace reads the remote device's files over the proxy, so
    // it is the one host action that still works from another machine.
    const editorActionReason = isBuiltInEditorEnabled() ? undefined : hostActionReason
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col bg-background",
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
          <NewSessionHeadline projectPath={pendingPath} />
        )}
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

  return <ProjectDashboard navigation={navigation} />
}

export function DesktopWorkspace({
  navigation,
  sessionView,
  project,
  chrome,
}: DesktopAppShellProps) {
  const { state, config } = useAppContext()
  const { session, sessionSource } = useSessionContext()

  function addProjectContext({
    path,
    text,
    startLine,
    endLine,
    comment,
  }: ProjectPromptContext): void {
    const context = formatProjectPromptContext({ path, text, startLine, endLine, comment })
    const current = sessionView.chatInputRef.current?.getText().trimEnd() ?? ""
    sessionView.chatInputRef.current?.setText(current ? `${current}\n\n${context}\n` : `${context}\n`)
    sessionView.chatInputRef.current?.focus()
  }

  const view = resolveDesktopMainView({
    mainView: state.mainView,
    hasSession: Boolean(session),
    pendingDirName: state.pendingDirName,
  })

  const sidebarHeader = (
    <SidebarHeader
      onToggleSidebar={navigation.panels.handleToggleSidebar}
      onGoHome={navigation.actions.handleGoHome}
      onOpenCommandPalette={chrome.onOpenCommandPalette}
      sidebarShortcut={shortcutLabel("toggleSidebar")}
      commandPaletteShortcut={shortcutLabel("commandPalette")}
    />
  )

  const sidebarRendered = navigation.panels.showSidebar && state.mainView !== "config"

  const panelContext: WorkspacePanelContext = {
    session,
    sessionChangeKey: state.sessionChangeKey,
    projectPath: project.currentCwd ?? null,
    hasFileChanges: project.hasFileChanges,
    canAccessHostFiles: can("hostFiles"),
    supportsWorktrees: project.supportsWorktrees,
  }
  const visiblePanels = availableWorkspacePanels(workspacePanels, panelContext)
  const activePanel = state.mainView === "sessions"
    ? visiblePanels.find((panel) => panel.id === navigation.panels.activeWorkspacePanel)
    : null
  const worktreeDirName = sessionSource?.dirName
    ?? state.pendingDirName
    ?? state.dashboardProject
    ?? null

  function toggleWorkspacePanel(panelId: string): void {
    if (project.showPreview) project.onCloseRightWorkspace()
    navigation.panels.toggleWorkspacePanel(panelId)
  }

  function openWorkspacePanel(panelId: string): void {
    if (project.showPreview) project.onCloseRightWorkspace()
    navigation.panels.openWorkspacePanel(panelId)
  }

  function openWorktreeSession(sessionId: string): void {
    if (!worktreeDirName) return
    navigation.actions.handleDashboardSelect(worktreeDirName, `${sessionId}.jsonl`)
    navigation.panels.closeWorkspacePanel()
  }

  const floatingChrome = (
    <FloatingChrome
      showSidebar={navigation.panels.showSidebar}
      sidebarRendered={sidebarRendered}
      sidebarShortcut={shortcutLabel("toggleSidebar")}
      killing={chrome.killing}
      creatingSession={navigation.creatingSession}
      onNewSession={navigation.onStartNewSession}
      onDuplicateSession={navigation.handlers.handleDuplicateSession}
      onOpenTerminal={project.onOpenTerminal}
      onBackToMain={sessionView.onBackToMain}
      onShowWorkflows={sessionView.onShowWorkflows}
      workflowCount={sessionView.workflowCount}
      onToggleSidebar={navigation.panels.handleToggleSidebar}
      onKillAll={chrome.onKillAll}
      onOpenSettings={config.openConfigDialog}
    />
  )

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
      {sidebarRendered && (
        <div className="view-transition-sidebar panel-enter w-80 shrink-0 border-r bg-sidebar text-sidebar-foreground">
          <PrimarySessionBrowser navigation={navigation} header={sidebarHeader} />
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
          jumpToTurn: navigation.actions.handleJumpToTurn,
          toggleServer: project.processPanel.handleToggleServer,
          serversChanged: project.processPanel.handleServersChanged,
          loadSession: navigation.handlers.handleLoadSessionScrollAware,
          worktrees: project.worktrees,
          worktreeDirName,
          openWorktreeSession,
        }}
        onClosePanel={navigation.panels.closeWorkspacePanel}
        onOpenPanel={openWorkspacePanel}
        onTogglePanel={toggleWorkspacePanel}
        actions={[
          {
            id: "mission-control",
            title: "Mission Control",
            icon: LayoutGrid,
            active: state.mainView === "mission",
            onSelect: navigation.panels.handleToggleMission,
          },
          ...(can("configWrite") ? [{
            id: "config",
            title: "Config",
            icon: SlidersHorizontal,
            active: state.mainView === "config",
            onSelect: navigation.panels.handleToggleConfig,
          }] : []),
        ]}
      >
        <main className="app-view-transition relative flex size-full min-w-0 flex-col overflow-hidden">
          {view !== "session" && floatingChrome}
          <DesktopMainView
            navigation={navigation}
            sessionView={sessionView}
            project={project}
            view={view}
            floatingChrome={floatingChrome}
          />
        </main>
      </DesktopWorkspacePanels>

      {project.showPreview && project.currentCwd && (
        <Suspense fallback={null}>
          <PreviewPanel cwd={project.currentCwd} onClose={project.onCloseRightWorkspace} />
        </Suspense>
      )}

    </div>
  )
}
