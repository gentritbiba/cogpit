import { Fragment, useMemo } from "react"
import { ChevronRight, FolderOpen, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { ProjectFavicon } from "@/components/ProjectFavicon"
import { ProjectContextMenu } from "@/components/ProjectContextMenu"
import { useProjectNames } from "@/hooks/useProjectNames"
import { cn } from "@/lib/utils"
import { formatRelativeTime, projectName, shortPath } from "@/lib/format"
import { ErrorBanner, SearchInput, SkeletonRows } from "./DashboardWidgets"

interface ProjectInfo {
  dirName: string
  path: string
  shortName: string
  sessionCount: number
  lastModified: string | null
}

interface ActiveSessionInfo {
  dirName: string
  lastModified: string
}

const LIVE_THRESHOLD_MS = 2 * 60 * 1000

function isLive(lastModified: string | null): boolean {
  if (!lastModified) return false
  return Date.now() - new Date(lastModified).getTime() < LIVE_THRESHOLD_MS
}

interface ProjectsViewProps {
  projects: ProjectInfo[]
  activeSessions: ActiveSessionInfo[]
  loading: boolean
  refreshing: boolean
  searchFilter: string
  setSearchFilter: (value: string) => void
  fetchError: string | null
  selectedProjectDirName: string | null
  onSelectProject?: (dirName: string | null) => void
  onRefresh: () => void
}

export function ProjectsView({
  projects,
  activeSessions,
  loading,
  refreshing,
  searchFilter,
  setSearchFilter,
  fetchError,
  selectedProjectDirName,
  onSelectProject,
  onRefresh,
}: ProjectsViewProps) {
  const activeCountByProject = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const session of activeSessions) {
      if (isLive(session.lastModified)) {
        counts[session.dirName] = (counts[session.dirName] || 0) + 1
      }
    }
    return counts
  }, [activeSessions])

  const { names: projectNames, rename: renameProject } = useProjectNames()

  const filteredProjects = useMemo(() => {
    if (!searchFilter) return projects
    const query = searchFilter.toLowerCase()
    return projects.filter((project) =>
      project.path.toLowerCase().includes(query)
      || project.shortName.toLowerCase().includes(query)
      || projectNames[project.dirName]?.toLowerCase().includes(query),
    )
  }, [projects, projectNames, searchFilter])

  return (
    <ScrollArea className="h-full">
      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
        <header className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <Badge variant="secondary">{projects.length}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Open a project to browse and resume its sessions.
          </p>
        </header>

        <section className="flex flex-col gap-4" aria-label="Projects">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <SearchInput
              value={searchFilter}
              onChange={setSearchFilter}
              placeholder="Filter projects..."
            />
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh projects"
            >
              <RefreshCw
                data-icon="inline-start"
                className={cn(refreshing && "animate-spin")}
              />
              Refresh
            </Button>
          </div>

          {fetchError && !selectedProjectDirName && (
            <ErrorBanner message={fetchError} onRetry={onRefresh} />
          )}

          {loading ? (
            <SkeletonRows />
          ) : filteredProjects.length === 0 ? (
            <Empty className="min-h-72 border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderOpen />
                </EmptyMedia>
                <EmptyTitle>
                  {searchFilter ? "No projects match your search" : "No projects yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {searchFilter
                    ? "Try a project name or path."
                    : "Start Claude Code or Codex and its project will appear here."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              {filteredProjects.map((project, index) => {
                const activeCount = activeCountByProject[project.dirName] || 0
                const customName = projectNames[project.dirName]

                return (
                  <Fragment key={project.dirName}>
                    {index > 0 && <Separator />}
                    <ProjectContextMenu
                      projectLabel={projectName(project.path)}
                      customName={customName}
                      onRename={(name) => renameProject(project.dirName, name)}
                    >
                      <button
                        type="button"
                        onClick={() => onSelectProject?.(project.dirName)}
                        className="group flex w-full flex-col gap-3 px-4 py-3.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:flex-row sm:items-center"
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-3">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40">
                            <ProjectFavicon
                              projectPath={project.path}
                              className="size-4"
                              fallback={<FolderOpen className="size-4 text-muted-foreground" />}
                            />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {customName || projectName(project.path)}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {shortPath(project.path)}
                            </span>
                          </span>
                        </span>

                        <span className="flex items-center gap-4 pl-11 text-sm text-muted-foreground sm:pl-0">
                          {activeCount > 0 && (
                            <Badge variant="secondary">
                              <span
                                aria-hidden="true"
                                data-icon="inline-start"
                                className="size-1.5 rounded-full bg-success"
                              />
                              {activeCount} active
                            </Badge>
                          )}
                          <span className="whitespace-nowrap">
                            {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
                          </span>
                          {project.lastModified && (
                            <span className="hidden w-24 whitespace-nowrap text-right md:inline">
                              {formatRelativeTime(project.lastModified)}
                            </span>
                          )}
                          <ChevronRight className="size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
                        </span>
                      </button>
                    </ProjectContextMenu>
                  </Fragment>
                )
              })}
            </div>
          )}
        </section>
      </main>
    </ScrollArea>
  )
}
