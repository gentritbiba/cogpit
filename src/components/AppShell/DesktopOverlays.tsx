import { lazy, useCallback, useEffect, useMemo, useState, Suspense } from "react"
import { FIND_IN_CONVERSATION_EVENT } from "@/components/ChatArea"
import type { CommandPaletteDevice } from "@/components/CommandPalette"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { useDevices } from "@/hooks/useDevices"
import { can } from "@/lib/capabilities"
import { LOCAL_DEVICE_ID, switchDevice } from "@/lib/device"
import { dirNameToPath } from "@/lib/format"
import { isEditableTarget, matchesKeybinding } from "@/lib/keybindings"
import { agentKindFromDirName, getResumeCommand } from "@/lib/sessionSource"
import { copyToClipboard } from "@/lib/utils"
import type { DesktopAppShellProps } from "./desktopTypes"

const CommandPaletteHost = lazy(() => import("@/components/CommandPaletteHost").then((module) => ({ default: module.CommandPaletteHost })))
const ConfigDialog = lazy(() => import("@/components/ConfigDialog").then((module) => ({ default: module.ConfigDialog })))
const DevicesDialog = lazy(() => import("@/components/DevicesDialog").then((module) => ({ default: module.DevicesDialog })))
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
  const { devices, activeDeviceId } = useDevices()
  const [devicesDialogMode, setDevicesDialogMode] = useState<null | "add" | "manage">(null)
  const canManageDevices = can("manageDevices")
  const pendingPath = state.pendingCwd
    ?? (state.pendingDirName ? dirNameToPath(state.pendingDirName) : null)
  const currentDirName = sessionSource?.dirName
    ?? state.pendingDirName
    ?? state.dashboardProject
    ?? null

  const onKeyboardShortcutsOpenChange = chrome.onKeyboardShortcutsOpenChange
  // "?" is the only way in for someone who does not already know ⌘K.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!matchesKeybinding("keyboardShortcuts", event)) return
      if (isEditableTarget(document.activeElement)) return
      event.preventDefault()
      onKeyboardShortcutsOpenChange(true)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onKeyboardShortcutsOpenChange])

  // Slot 1 is always this machine, 2..9 follow registry order — the same
  // ordering the device-switch shortcuts use in DeviceRoot.
  const paletteDevices = useMemo<CommandPaletteDevice[]>(() => [
    {
      id: LOCAL_DEVICE_ID,
      name: "This machine",
      isLocal: true,
      isActive: activeDeviceId === LOCAL_DEVICE_ID,
    },
    ...devices.map((device) => ({
      id: device.id,
      name: device.name,
      isLocal: false,
      isActive: device.id === activeDeviceId,
    })),
  ], [devices, activeDeviceId])

  const handleCopyResumeCommand = useCallback(() => {
    if (!session) return
    const agentKind = sessionSource?.agentKind ?? agentKindFromDirName(sessionSource?.dirName ?? null)
    void copyToClipboard(getResumeCommand(agentKind, session.sessionId, session.cwd))
  }, [session, sessionSource])

  const handleFindInConversation = useCallback(() => {
    window.dispatchEvent(new Event(FIND_IN_CONVERSATION_EVENT))
  }, [])

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
          onToggleMissionControl={navigation.panels.handleToggleMission}
          onDuplicateSession={session ? navigation.handlers.handleDuplicateSession : undefined}
          onCopyResumeCommand={session ? handleCopyResumeCommand : undefined}
          onFindInConversation={session ? handleFindInConversation : undefined}
          onKillAll={can("killAny") ? chrome.onKillAll : undefined}
          onOpenConfig={can("configWrite") ? navigation.panels.handleToggleConfig : undefined}
          onOpenSettings={config.openConfigDialog}
          onOpenKeyboardShortcuts={() => onKeyboardShortcutsOpenChange(true)}
          onTogglePreview={project.currentCwd ? project.onTogglePreview : undefined}
          onToggleProjectFiles={can("hostFiles") && project.currentCwd ? project.onToggleProjectFiles : undefined}
          onOpenTheme={navigation.panels.handleToggleThemeSelector}
          onOpenTerminal={project.onOpenTerminal}
          onOpenDevices={canManageDevices ? setDevicesDialogMode : undefined}
          onSwitchDevice={switchDevice}
          devices={paletteDevices}
          onFocusComposer={chrome.onFocusComposer}
          onExpandAll={chrome.onExpandAll}
          onCollapseAll={chrome.onCollapseAll}
          canFocusComposer={Boolean(session || state.pendingDirName)}
          canOpenTerminal={can("terminal") && Boolean(
            session?.cwd
            ?? pendingPath
            ?? sessionSource?.dirName
            ?? state.pendingDirName
            ?? state.dashboardProject
          )}
          hasSession={Boolean(session)}
          hasFileChanges={can("hostFiles") && project.hasFileChanges}
          supportsWorktrees={project.supportsWorktrees}
          showSidebar={navigation.panels.showSidebar}
          showStats={navigation.panels.showStats}
          showProjectFiles={project.showProjectFiles}
          showFileChanges={navigation.panels.showFileChanges}
          showWorktrees={navigation.panels.showWorktrees}
          showConfig={state.mainView === "config"}
          showMission={state.mainView === "mission"}
          currentProjectDirName={currentDirName}
          projectCwd={session?.cwd ?? pendingPath ?? null}
          onProcessStarted={project.processPanel.addProcess}
          launchTerminalRequest={project.launchTerminalRequest}
        />
      </Suspense>

      <Suspense fallback={null}>
        <KeyboardShortcutsDialog
          open={chrome.keyboardShortcutsOpen}
          onOpenChange={onKeyboardShortcutsOpenChange}
        />
      </Suspense>

      {canManageDevices && devicesDialogMode !== null && (
        <Suspense fallback={null}>
          <DevicesDialog
            open
            initialMode={devicesDialogMode}
            onClose={() => setDevicesDialogMode(null)}
          />
        </Suspense>
      )}

      {chrome.status}
    </>
  )
}
