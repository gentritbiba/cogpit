import { lazy, Suspense } from "react"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { dirNameToPath } from "@/lib/format"
import type { DesktopAppShellProps } from "./desktopTypes"

const CommandPaletteHost = lazy(() => import("@/components/CommandPaletteHost").then((module) => ({ default: module.CommandPaletteHost })))
const ConfigDialog = lazy(() => import("@/components/ConfigDialog").then((module) => ({ default: module.ConfigDialog })))
const KeyboardShortcutsDialog = lazy(() => import("@/components/KeyboardShortcutsDialog").then((module) => ({ default: module.KeyboardShortcutsDialog })))
const ProjectSwitcherModal = lazy(() => import("@/components/ProjectSwitcherModal").then((module) => ({ default: module.ProjectSwitcherModal })))
const ThemeSelectorModal = lazy(() => import("@/components/ThemeSelectorModal").then((module) => ({ default: module.ThemeSelectorModal })))
const WorktreePanel = lazy(() => import("@/components/WorktreePanel").then((module) => ({ default: module.WorktreePanel })))

type DesktopOverlaysProps = Pick<
  DesktopAppShellProps,
  "navigation" | "project" | "chrome"
>

export function DesktopOverlays({
  navigation,
  project,
  chrome,
}: DesktopOverlaysProps) {
  const { state, config, theme } = useAppContext()
  const { session, sessionSource } = useSessionContext()
  const pendingPath = state.pendingCwd
    ?? (state.pendingDirName ? dirNameToPath(state.pendingDirName) : null)
  const currentDirName = sessionSource?.dirName
    ?? state.pendingDirName
    ?? state.dashboardProject
    ?? null

  return (
    <>
      <Suspense fallback={null}>
        <WorktreePanel
          open={project.supportsWorktrees && navigation.panels.showWorktrees}
          onOpenChange={navigation.panels.setShowWorktrees}
          worktrees={project.worktrees.worktrees}
          loading={project.worktrees.loading}
          dirName={currentDirName}
          onRefetch={project.worktrees.refetch}
          onOpenSession={(sessionId) => {
            if (currentDirName) {
              navigation.actions.handleDashboardSelect(currentDirName, `${sessionId}.jsonl`)
            }
            navigation.panels.setShowWorktrees(false)
          }}
        />
      </Suspense>

      {chrome.processPanel}
      {chrome.workflowsPanel}
      {chrome.undoDialog}
      {chrome.branchModal}

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
          open={navigation.panels.showProjectSwitcher}
          onClose={navigation.panels.handleCloseProjectSwitcher}
          onNewSession={navigation.onStartNewSession}
          onNewFolder={navigation.onStartNewFolder}
          defaultAgentKind={config.defaultAgentKind}
          currentProjectDirName={sessionSource?.dirName ?? state.pendingDirName ?? null}
          currentProjectCwd={session?.cwd ?? state.pendingCwd ?? null}
        />
      </Suspense>

      <Suspense fallback={null}>
        <ThemeSelectorModal
          open={navigation.panels.showThemeSelector}
          onClose={navigation.panels.handleCloseThemeSelector}
          currentTheme={theme.theme}
          onSelectTheme={theme.setTheme}
          onPreviewTheme={theme.setPreview}
        />
      </Suspense>

      <Suspense fallback={null}>
        <CommandPaletteHost
          open={chrome.commandPaletteOpen}
          onOpenChange={chrome.onCommandPaletteOpenChange}
          onGoHome={navigation.actions.handleGoHome}
          onNewSession={navigation.panels.handleOpenProjectSwitcher}
          onOpenProject={navigation.onOpenPaletteProject}
          onOpenSession={navigation.actions.handleDashboardSelect}
          onToggleSidebar={navigation.panels.handleToggleSidebar}
          onToggleStats={navigation.panels.handleToggleStats}
          onToggleFileChanges={navigation.panels.handleToggleFileChanges}
          onToggleWorktrees={navigation.panels.handleToggleWorktrees}
          onOpenConfig={navigation.panels.handleToggleConfig}
          onOpenSettings={config.openConfigDialog}
          onOpenKeyboardShortcuts={() => chrome.onKeyboardShortcutsOpenChange(true)}
          onTogglePreview={project.currentCwd ? project.onTogglePreview : undefined}
          onToggleProjectFiles={project.currentCwd ? project.onToggleProjectFiles : undefined}
          onOpenTheme={navigation.panels.handleToggleThemeSelector}
          onOpenTerminal={project.onOpenTerminal}
          onFocusComposer={chrome.onFocusComposer}
          onExpandAll={chrome.onExpandAll}
          onCollapseAll={chrome.onCollapseAll}
          canFocusComposer={Boolean(session || state.pendingDirName)}
          canOpenTerminal={Boolean(
            session?.cwd
            ?? pendingPath
            ?? sessionSource?.dirName
            ?? state.pendingDirName
            ?? state.dashboardProject
          )}
          hasSession={Boolean(session)}
          hasFileChanges={project.hasFileChanges}
          supportsWorktrees={project.supportsWorktrees}
          showSidebar={navigation.panels.showSidebar}
          showStats={navigation.panels.showStats}
          showProjectFiles={project.showProjectFiles}
          showFileChanges={navigation.panels.showFileChanges}
          showWorktrees={navigation.panels.showWorktrees}
          showConfig={state.mainView === "config"}
          currentProjectDirName={currentDirName}
          projectCwd={session?.cwd ?? pendingPath ?? null}
          onProcessStarted={project.processPanel.addProcess}
          launchTerminalRequest={project.launchTerminalRequest}
        />
      </Suspense>

      <Suspense fallback={null}>
        <KeyboardShortcutsDialog
          open={chrome.keyboardShortcutsOpen}
          onOpenChange={chrome.onKeyboardShortcutsOpenChange}
        />
      </Suspense>

      {chrome.status}
    </>
  )
}
