import { lazy, Suspense } from "react"
import { Code2, FolderSearch, TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DisabledHint } from "@/components/ui/disabled-hint"
import { ChatArea } from "@/components/ChatArea"
import { FileChangesPanel } from "@/components/FileChangesPanel"
import { HoverRevealPanel } from "@/components/HoverRevealPanel"
import { StatsPanel } from "@/components/StatsPanel"
import { TodoProgressPanel } from "@/components/TodoProgressPanel"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { can } from "@/lib/capabilities"
import { isRemoteDeviceActive } from "@/lib/device"
import { dirNameToPath } from "@/lib/format"
import { cn } from "@/lib/utils"
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
import type { DesktopAppShellProps } from "./desktopTypes"

const ConfigBrowser = lazy(() => import("@/components/ConfigBrowser").then((module) => ({ default: module.ConfigBrowser })))
const PreviewPanel = lazy(() => import("@/components/PreviewPanel").then((module) => ({ default: module.PreviewPanel })))
const ProjectFilesPanel = lazy(() => import("@/components/ProjectFilesPanel").then((module) => ({ default: module.ProjectFilesPanel })))

type DesktopWorkspaceProps = Pick<
  DesktopAppShellProps,
  "navigation" | "sessionView" | "project"
>

function DesktopSessionContent({
  navigation,
  sessionView,
  project,
}: DesktopWorkspaceProps) {
  const { state } = useAppContext()
  const { session } = useSessionContext()
  if (!session) return null

  return (
    <div className="flex min-h-0 flex-1 bg-background">
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={project.hasFileChanges && navigation.panels.showFileChanges ? 70 : 100} minSize="500px">
          <div className="relative flex h-full min-h-0 flex-col">
            {sessionView.teamMembersBar}
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
        </ResizablePanel>

        {project.hasFileChanges && navigation.panels.showFileChanges && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={30}
              minSize={0}
              collapsible
              onResize={sessionView.onFileChangesPanelResize}
            >
              {!sessionView.fileChangesCollapsed && (
                <FileChangesPanel session={session} sessionChangeKey={state.sessionChangeKey} />
              )}
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  )
}

function DesktopMainView({
  navigation,
  sessionView,
  project,
}: DesktopWorkspaceProps) {
  const { state } = useAppContext()
  const { session, sessionSource } = useSessionContext()
  const pendingPath = state.pendingCwd
    ?? (state.pendingDirName ? dirNameToPath(state.pendingDirName) : null)
  const view = resolveDesktopMainView({
    mainView: state.mainView,
    hasSession: Boolean(session),
    pendingDirName: state.pendingDirName,
  })

  if (view === "config") {
    return (
      <Suspense fallback={<LazyViewFallback label="Loading configuration…" />}>
        <div className="motion-session-enter flex min-h-0 flex-1">
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
    return <MissionControlView navigation={navigation} />
  }

  if (view === "session") {
    return (
      <DesktopSessionContent
        navigation={navigation}
        sessionView={sessionView}
        project={project}
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
          <div className="flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto max-w-4xl">
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
                <DisabledHint reason={hostActionReason}>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={Boolean(hostActionReason)}
                    onClick={() => project.onPostProjectAction("/api/open-in-editor")}
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
                    onClick={() => project.onPostProjectAction("/api/reveal-in-folder")}
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
}: DesktopWorkspaceProps) {
  const { state } = useAppContext()
  const { session } = useSessionContext()

  function addProjectContext({
    path,
    text,
    startLine,
    endLine,
    comment,
  }: {
    path: string
    text?: string
    startLine?: number
    endLine?: number
    comment?: string
  }): void {
    const context = formatProjectPromptContext({ path, text, startLine, endLine, comment })
    const current = sessionView.chatInputRef.current?.getText().trimEnd() ?? ""
    sessionView.chatInputRef.current?.setText(current ? `${current}\n\n${context}\n` : `${context}\n`)
    sessionView.chatInputRef.current?.focus()
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
      {navigation.panels.showSidebar && state.mainView !== "config" && (
        <div className="view-transition-sidebar panel-enter w-80 shrink-0 border-r bg-sidebar text-sidebar-foreground">
          <PrimarySessionBrowser navigation={navigation} />
        </div>
      )}

      <main className="app-view-transition relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <DesktopMainView
          navigation={navigation}
          sessionView={sessionView}
          project={project}
        />
      </main>

      <HoverRevealPanel
        side="right"
        visible={!project.showPreview && !project.showProjectFiles && navigation.panels.showStats && Boolean(session) && state.mainView !== "config"}
        enabled={!project.showPreview && !project.showProjectFiles && Boolean(session) && state.mainView !== "config"}
      >
        <StatsPanel
          onJumpToTurn={navigation.actions.handleJumpToTurn}
          onToggleServer={project.processPanel.handleToggleServer}
          onServersChanged={project.processPanel.handleServersChanged}
          searchInputRef={sessionView.searchInputRef}
          onLoadSession={navigation.handlers.handleLoadSessionScrollAware}
          backgroundAgents={project.backgroundAgents}
        />
      </HoverRevealPanel>

      {project.showPreview && project.currentCwd && (
        <Suspense fallback={null}>
          <PreviewPanel cwd={project.currentCwd} onClose={project.onCloseRightWorkspace} />
        </Suspense>
      )}

      {project.showProjectFiles && project.currentCwd && (
        <Suspense fallback={null}>
          <ProjectFilesPanel
            cwd={project.currentCwd}
            onClose={project.onCloseRightWorkspace}
            onAddToPrompt={addProjectContext}
          />
        </Suspense>
      )}
    </div>
  )
}
