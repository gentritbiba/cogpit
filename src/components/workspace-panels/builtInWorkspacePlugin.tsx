import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { FileCode2, FolderTree, GitBranch, Globe, PanelRight } from "lucide-react"
import { FileChangesPanel } from "@/components/FileChangesPanel"
import { StatsPanel } from "@/components/StatsPanel"
import { Spinner } from "@/components/ui/Spinner"
import {
  definePlugin,
  type WorkspacePanelIndicatorProps,
  type WorkspacePanelProps,
} from "@/plugin-api"
import { BUILT_IN_PLUGIN_ID } from "@/plugins/builtInPanelIds"
import { latestBrowserActivity } from "../../../shared/session/browserActivity"
import { useBuiltInPanelServices } from "./BuiltInPanelServices"

/** How long the rail keeps marking the icon after the agent's last browser call. */
const BROWSING_MS = 10_000

const ProjectFilesPanel = lazy(() =>
  import("@/components/ProjectFilesPanel").then((module) => ({ default: module.ProjectFilesPanel })),
)
const WorktreePanel = lazy(() =>
  import("@/components/WorktreePanel").then((module) => ({ default: module.WorktreePanel })),
)
const BrowserPanel = lazy(() =>
  import("@/components/BrowserPanel").then((module) => ({ default: module.BrowserPanel })),
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

function BrowserWorkspacePanel(props: WorkspacePanelProps) {
  return (
    <Suspense fallback={<PanelFallback />}>
      <BrowserPanel {...props} />
    </Suspense>
  )
}

/**
 * A dot on the rail while the agent is driving a browser, so the panel is
 * worth opening. One timeout, armed for the moment the last call goes stale —
 * a new call re-arms it, and a session that never browses schedules nothing.
 */
function BrowserActivityIndicator({ context }: WorkspacePanelIndicatorProps) {
  const [, expire] = useState(0)
  // The rail re-renders on anything; the transcript is only walked when it moves.
  const at = useMemo(
    () => Date.parse(latestBrowserActivity(context.session)?.timestamp ?? ""),
    [context.session],
  )

  useEffect(() => {
    const remaining = at + BROWSING_MS - Date.now()
    if (Number.isNaN(remaining) || remaining <= 0) return
    const timer = setTimeout(() => expire((tick) => tick + 1), remaining)
    return () => clearTimeout(timer)
  }, [at])

  if (Number.isNaN(at) || Date.now() - at >= BROWSING_MS) return null
  return (
    <span
      role="status"
      aria-label="The agent is using the browser"
      className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-emerald-500 motion-safe:animate-pulse"
    />
  )
}

function WorktreesWorkspacePanel({ closePanel }: WorkspacePanelProps) {
  const services = useBuiltInPanelServices()
  return (
    <Suspense fallback={<PanelFallback />}>
      <WorktreePanel
        worktrees={services.worktrees.worktrees}
        loading={services.worktrees.loading}
        dirName={services.worktreeDirName}
        onRefetch={services.worktrees.refetch}
        onOpenSession={services.openWorktreeSession}
        onClose={closePanel}
      />
    </Suspense>
  )
}

export const builtInWorkspacePlugin = definePlugin({
  id: BUILT_IN_PLUGIN_ID,
  workspacePanels: [
    {
      id: "worktrees",
      title: "Worktrees",
      icon: GitBranch,
      component: WorktreesWorkspacePanel,
      order: 5,
      defaultSize: "36%",
      minSize: "320px",
      when: (context) => context.supportsWorktrees === true,
    },
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
      id: "browser",
      title: "Browser",
      icon: Globe,
      component: BrowserWorkspacePanel,
      indicator: BrowserActivityIndicator,
      order: 15,
      defaultSize: "46%",
      minSize: "360px",
      maxSize: "75%",
      keepAlive: true,
      when: (context) => context.canAccessHostFiles,
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
