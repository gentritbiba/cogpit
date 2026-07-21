import { lazy, Suspense } from "react"
import { Code2, FolderSearch, TerminalSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ChatArea } from "@/components/ChatArea"
import { FileChangesPanel } from "@/components/FileChangesPanel"
import { HoverRevealPanel } from "@/components/HoverRevealPanel"
import { SessionInfoBar } from "@/components/SessionInfoBar"
import { SessionStatusBar } from "@/components/SessionStatusBar"
import { StatsPanel } from "@/components/StatsPanel"
import { TodoProgressPanel } from "@/components/TodoProgressPanel"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { isRemoteDeviceActive } from "@/lib/device"
import { dirNameToPath, shortPath } from "@/lib/format"
import { SessionInputFooter } from "./SessionInputFooter"
import {
  PrimarySessionBrowser,
  ProjectDashboard,
  SelectedTeamDashboard,
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
  const { session, isSubAgentView } = useSessionContext()
  if (!session) return null

  return (
    <div className="flex flex-1 min-h-0">
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        <ResizablePanel defaultSize={project.hasFileChanges && navigation.panels.showFileChanges ? 70 : 100} minSize="500px">
          <div className="relative h-full min-h-0 flex flex-col">
            {sessionView.teamMembersBar}
            {sessionView.agentContextBar}
            <SessionInfoBar
              creatingSession={navigation.creatingSession}
              onNewSession={navigation.onStartNewSession}
              onDuplicateSession={navigation.handlers.handleDuplicateSession}
              onOpenTerminal={project.onOpenTerminal}
              onBackToMain={isSubAgentView ? sessionView.onBackToMain : undefined}
              onShowWorkflows={sessionView.onShowWorkflows}
              workflowCount={sessionView.workflowCount}
            />
            <SessionStatusBar
              session={session}
              thinkingEnabled={session.turns.some((turn) => turn.thinking.length > 0)}
            />
            <ChatArea
              searchInputRef={sessionView.searchInputRef}
              hasTodos={Boolean(sessionView.todoProgress) && sessionView.todosExpanded}
              hasMore={sessionView.hasMoreTurns}
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
    selectedTeam: state.selectedTeam,
    hasSession: Boolean(session),
    pendingDirName: state.pendingDirName,
  })

  if (view === "config") {
    return (
      <Suspense fallback={null}>
        <ConfigBrowser
          projectPath={resolveDesktopProjectPath({
            sessionCwd: session?.cwd,
            pendingPath,
            sessionDirPath: sessionSource?.dirName ? dirNameToPath(sessionSource.dirName) : null,
            dashboardProjectPath: state.dashboardProject ? dirNameToPath(state.dashboardProject) : null,
          })}
          initialFilePath={state.configFilePath}
        />
      </Suspense>
    )
  }

  if (view === "teams" && state.selectedTeam) {
    return <SelectedTeamDashboard navigation={navigation} />
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
    return (
      <div className="flex flex-1 min-h-0 flex-col min-w-0">
        {sessionView.pendingTurns.length > 0 ? (
          <div className="flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto max-w-3xl">
              {sessionView.pendingTurns}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-1">
            <p className="text-sm text-muted-foreground">New session — type your first message below</p>
            <p className="text-xs text-muted-foreground font-mono">{shortPath(pendingPath ?? "")}</p>
            {!isRemoteDeviceActive() && (
              <div className="flex items-center gap-1 mt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-emerald-400 hover:bg-emerald-500/20"
                  onClick={project.onOpenTerminal}
                >
                  <TerminalSquare className="size-3" />
                  Terminal
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 gap-1.5 text-[11px] text-muted-foreground hover:text-blue-400 hover:bg-blue-500/20"
                  onClick={() => project.onPostProjectAction("/api/open-in-editor")}
                >
                  <Code2 className="size-3" />
                  Open
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 gap-1.5 text-[11px] text-zinc-500 hover:text-amber-400 hover:bg-amber-500/10"
                  onClick={() => project.onPostProjectAction("/api/reveal-in-folder")}
                >
                  <FolderSearch className="size-3" />
                  Reveal
                </Button>
              </div>
            )}
          </div>
        )}
        <SessionInputFooter>{sessionView.pendingComposer}</SessionInputFooter>
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
    <div className="relative flex flex-1 min-h-0 overflow-hidden">
      <HoverRevealPanel
        side="left"
        visible={navigation.panels.showSidebar && state.mainView !== "config"}
        enabled={state.mainView !== "config"}
      >
        <PrimarySessionBrowser
          navigation={navigation}
          projectDir={session?.cwd ?? state.pendingCwd ?? null}
          onScriptStarted={project.processPanel.addProcess}
        />
      </HoverRevealPanel>

      <main className="relative flex-1 min-w-0 overflow-hidden flex flex-col">
        <DesktopMainView
          navigation={navigation}
          sessionView={sessionView}
          project={project}
        />
      </main>

      <HoverRevealPanel
        side="right"
        visible={!project.showPreview && !project.showProjectFiles && navigation.panels.showStats && Boolean(session) && state.mainView !== "teams" && state.mainView !== "config"}
        enabled={!project.showPreview && !project.showProjectFiles && Boolean(session) && state.mainView !== "teams" && state.mainView !== "config"}
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
