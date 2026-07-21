import { DesktopHeader } from "@/components/DesktopHeader"
import { UpdateBanner } from "@/components/UpdateBanner"
import { useAppContext } from "@/contexts/AppContext"
import { shortcutLabel } from "@/lib/keybindings"
import { DesktopOverlays } from "./DesktopOverlays"
import { DesktopWorkspace } from "./DesktopWorkspace"
import type { DesktopAppShellProps } from "./desktopTypes"

/** Desktop-only application composition: chrome, workspace, and global overlays. */
export function DesktopAppShell({
  navigation,
  sessionView,
  project,
  chrome,
}: DesktopAppShellProps) {
  const { state, config, theme } = useAppContext()

  return (
    <div className={`${theme.themeClasses} flex h-dvh flex-col bg-elevation-0 text-foreground`}>
      {chrome.backgroundServers}
      <UpdateBanner />
      <DesktopHeader
        showSidebar={navigation.panels.showSidebar}
        showStats={navigation.panels.showStats}
        showWorktrees={project.supportsWorktrees && navigation.panels.showWorktrees}
        showFileChanges={navigation.panels.showFileChanges}
        hasFileChanges={project.hasFileChanges}
        killing={chrome.killing}
        onGoHome={navigation.actions.handleGoHome}
        onToggleSidebar={navigation.panels.handleToggleSidebar}
        onToggleStats={navigation.panels.handleToggleStats}
        onToggleWorktrees={project.supportsWorktrees ? navigation.panels.handleToggleWorktrees : undefined}
        onToggleFileChanges={navigation.panels.handleToggleFileChanges}
        showConfig={state.mainView === "config"}
        onToggleConfig={navigation.panels.handleToggleConfig}
        onKillAll={chrome.onKillAll}
        onOpenSettings={config.openConfigDialog}
        onOpenCommandPalette={chrome.onOpenCommandPalette}
        commandPaletteShortcut={shortcutLabel("commandPalette")}
      />

      <DesktopWorkspace
        navigation={navigation}
        sessionView={sessionView}
        project={project}
      />

      <DesktopOverlays
        navigation={navigation}
        project={project}
        chrome={chrome}
      />
    </div>
  )
}
