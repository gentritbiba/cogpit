import { lazy, Suspense, useCallback, useState } from "react"
import { LayoutGrid, Puzzle, SlidersHorizontal } from "lucide-react"
import { useAppContext } from "@/contexts/AppContext"
import { useSessionContext } from "@/contexts/SessionContext"
import { BuiltInPanelServicesProvider } from "@/components/workspace-panels/BuiltInPanelServices"
import { MobileWorkspacePanels } from "@/components/workspace-panels/MobileWorkspacePanels"
import type { WorkspacePanelContext } from "@/plugin-api"
import { useRuntimePlugins } from "@/plugins/useRuntimePlugins"
import { useRuntimeWorkspacePanels } from "@/plugins/runtimeWorkspacePanels"
import { resolvePluginPanelPreference } from "@/plugins/panelAliases"
import { useCapability } from "@/hooks/useCapability"
import { formatProjectPromptContext } from "./desktopView"
import { LazyViewFallback, MissionControlView } from "./SharedAppViews"
import type { MobileAppShellProps } from "./mobileTypes"

const PluginsDialog = lazy(() => import("@/plugins/PluginsDialog").then((module) => ({ default: module.PluginsDialog })))
const ConfigBrowser = lazy(() => import("@/components/ConfigBrowser").then((module) => ({ default: module.ConfigBrowser })))

export function MobileWorkspace({ navigation, sessionView, project, active }: MobileAppShellProps & { active: boolean }) {
  const { state } = useAppContext()
  const { session, sessionSource } = useSessionContext()
  const canAccessHostFiles = useCapability("hostFiles")
  const canConfigure = useCapability("configWrite")
  const [pluginsOpen, setPluginsOpen] = useState(() => new URLSearchParams(window.location.search).get("pluginSafeMode") === "1")
  const [pluginSettingsId, setPluginSettingsId] = useState<string>()
  const openPluginSettings = useCallback((pluginId: string) => { setPluginSettingsId(pluginId); setPluginsOpen(true) }, [])
  const runtimePlugins = useRuntimePlugins(canConfigure)
  const workspacePanels = useRuntimeWorkspacePanels({ ...runtimePlugins, projectPath: project.currentCwd ?? null, openSettings: openPluginSettings })
  const [utility, setUtility] = useState<"mission" | "config" | null>(null)
  const { panels } = navigation
  const selectedUtility = panels.activeWorkspacePanel === null ? utility : null
  const worktreeDirName = sessionSource?.dirName ?? state.pendingDirName ?? state.dashboardProject

  function closePanel() {
    setUtility(null)
    panels.closeWorkspacePanel()
  }

  function openUtility(value: "mission" | "config") {
    panels.closeWorkspacePanel()
    setUtility(value)
  }

  function composePrompt(text: string) {
    const input = sessionView.chatInputRef.current
    const current = input?.getText().trimEnd() ?? ""
    input?.setText(current ? `${current}\n\n${text}\n` : `${text}\n`)
    navigation.actions.handleMobileTabChange("chat")
    requestAnimationFrame(() => input?.focus())
  }

  const context: WorkspacePanelContext = {
    session,
    sessionAddress: sessionSource ? { dirName: sessionSource.dirName, fileName: sessionSource.fileName } : null,
    sessionChangeKey: state.sessionChangeKey,
    projectPath: project.currentCwd ?? null,
    hasFileChanges: project.hasFileChanges,
    canAccessHostFiles,
    supportsWorktrees: project.supportsWorktrees,
    openSession: navigation.handlers.handleLoadSessionScrollAware,
    composePrompt,
  }

  return (
    <BuiltInPanelServicesProvider value={{
      projectFilesRoot: project.projectFilesRoot ?? project.currentCwd ?? null,
      projectFilesRequest: project.projectFilesRequest,
      backgroundAgents: project.backgroundAgents,
      searchInputRef: sessionView.searchInputRef,
      addProjectContext: (value) => composePrompt(formatProjectPromptContext(value)),
      jumpToTurn: navigation.handlers.handleMobileJumpToTurn,
      toggleServer: (...args) => {
        project.processPanel.handleToggleServer(...args)
        navigation.actions.handleMobileTabChange("chat")
      },
      serversChanged: project.processPanel.handleServersChanged,
      loadSession: navigation.handlers.handleLoadSessionScrollAware,
      worktrees: project.worktrees,
      worktreeDirName,
      openWorktreeSession: (sessionId) => {
        if (worktreeDirName) navigation.actions.handleDashboardSelect(worktreeDirName, `${sessionId}.jsonl`)
      },
    }}>
      <MobileWorkspacePanels
        panels={workspacePanels}
        context={context}
        activePanelId={resolvePluginPanelPreference(panels.activeWorkspacePanel, workspacePanels)?.id ?? panels.activeWorkspacePanel}
        active={active}
        onSelectPanel={(id) => { setUtility(null); panels.openWorkspacePanel(id) }}
        onClosePanel={closePanel}
        actions={[
          ...(canConfigure ? [{ id: "plugins", title: "Plugins", icon: Puzzle, active: false, onSelect: () => setPluginsOpen(true) }] : []),
          { id: "mission", title: "Mission Control", icon: LayoutGrid, active: selectedUtility === "mission", onSelect: () => openUtility("mission") },
          ...(canConfigure ? [{ id: "config", title: "Config", icon: SlidersHorizontal, active: selectedUtility === "config", onSelect: () => openUtility("config") }] : []),
        ]}
        actionContent={selectedUtility === "mission" ? (
          <div className="flex h-full min-h-0 flex-col"><MissionControlView navigation={navigation} /></div>
        ) : selectedUtility === "config" && canConfigure ? (
          <Suspense fallback={<LazyViewFallback label="Loading configuration…" />}>
            <div className="flex h-full min-h-0"><ConfigBrowser projectPath={project.currentCwd ?? null} initialFilePath={state.configFilePath} /></div>
          </Suspense>
        ) : null}
      />
      {pluginsOpen && canConfigure && <Suspense fallback={null}>
        <PluginsDialog client={runtimePlugins.client} state={runtimePlugins} currentPath={project.currentCwd ?? null} initialPluginId={pluginSettingsId}
          onClose={() => { setPluginsOpen(false); setPluginSettingsId(undefined) }} />
      </Suspense>}
    </BuiltInPanelServicesProvider>
  )
}
