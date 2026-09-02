import { lazy, Suspense } from "react"
import { FileCode2, FolderTree, PanelRight } from "lucide-react"
import { FileChangesPanel } from "@/components/FileChangesPanel"
import { StatsPanel } from "@/components/StatsPanel"
import { Spinner } from "@/components/ui/Spinner"
import { definePlugin, type WorkspacePanelProps } from "@/plugin-api"
import { BUILT_IN_PLUGIN_ID } from "@/plugins/builtInPanelIds"
import { useBuiltInPanelServices } from "./BuiltInPanelServices"

const ProjectFilesPanel = lazy(() =>
  import("@/components/ProjectFilesPanel").then((module) => ({ default: module.ProjectFilesPanel })),
)

function PanelFallback() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <Spinner />
      Loading panel…
    </div>
  )
}

function ProjectFilesWorkspacePanel({ context, closePanel }: WorkspacePanelProps) {
  const services = useBuiltInPanelServices()
  const root = services.projectFilesRoot ?? context.projectPath
  if (!root) return null
  return (
    <Suspense fallback={<PanelFallback />}>
      <ProjectFilesPanel
        key={root}
        cwd={root}
        onClose={closePanel}
        onAddToPrompt={services.addProjectContext}
        openRequest={services.projectFilesRequest}
        embedded
      />
    </Suspense>
  )
}

function FileChangesWorkspacePanel({ context }: WorkspacePanelProps) {
  if (!context.session) return null
  return (
    <FileChangesPanel
      session={context.session}
      sessionChangeKey={context.sessionChangeKey}
    />
  )
}

function SessionInfoWorkspacePanel() {
  const services = useBuiltInPanelServices()
  return (
    <StatsPanel
      embedded
      onJumpToTurn={services.jumpToTurn}
      onToggleServer={services.toggleServer}
      onServersChanged={services.serversChanged}
      searchInputRef={services.searchInputRef}
      onLoadSession={services.loadSession}
      backgroundAgents={services.backgroundAgents}
    />
  )
}

export const builtInWorkspacePlugin = definePlugin({
  id: BUILT_IN_PLUGIN_ID,
  workspacePanels: [
    {
      id: "project-files",
      title: "Project files",
      icon: FolderTree,
      component: ProjectFilesWorkspacePanel,
      order: 10,
      defaultSize: "55%",
      minSize: "340px",
      maxSize: "75%",
      keepAlive: true,
      when: (context) => context.canAccessHostFiles && context.projectPath !== null,
    },
    {
      id: "file-changes",
      title: "File changes",
      icon: FileCode2,
      component: FileChangesWorkspacePanel,
      order: 20,
      defaultSize: "36%",
      minSize: "320px",
      when: (context) => context.canAccessHostFiles && context.hasFileChanges && context.session !== null,
    },
    {
      id: "session-info",
      title: "Session details",
      icon: PanelRight,
      component: SessionInfoWorkspacePanel,
      order: 30,
      defaultSize: "36%",
      minSize: "320px",
      when: (context) => context.session !== null,
    },
  ],
})
