import { useMemo } from "react"
import {
  Cog,
  RefreshCw,
  FolderOpen,
  Clock,
  ChevronRight,
  FileText,
  Activity,
  Keyboard,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { formatRelativeTime, shortPath, projectName } from "@/lib/format"
import { SearchInput, ErrorBanner, SkeletonCards, LiveDot, Shortcut, isMac } from "./DashboardWidgets"

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

export interface ProjectsViewProps {
  projects: ProjectInfo[]
  activeSessions: ActiveSessionInfo[]
  loading: boolean
  refreshing: boolean
  searchFilter: string
  setSearchFilter: (v: string) => void
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
    const map: Record<string, number> = {}
    for (const s of activeSessions) {
      if (isLive(s.lastModified)) {
        map[s.dirName] = (map[s.dirName] || 0) + 1
      }
    }
    return map
  }, [activeSessions])

  const filteredProjects = useMemo(() => {
    if (!searchFilter) return projects
    const q = searchFilter.toLowerCase()
    return projects.filter(
      (p) => p.path.toLowerCase().includes(q) || p.shortName.toLowerCase().includes(q)
    )
  }, [projects, searchFilter])

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl px-6 py-8 fade-in">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Cog className="size-7 text-blue-400" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Cogpit
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">Session Viewer & Monitor</p>
        </div>

        {/* Projects Section */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
              Projects
            </h2>
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium">
              {projects.length}
            </Badge>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh projects"
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
            </Button>
          </div>

          <SearchInput value={searchFilter} onChange={setSearchFilter} placeholder="Filter projects..." />

          {fetchError && !selectedProjectDirName && (
            <ErrorBanner
              message={fetchError}
              onRetry={onRefresh}
            />
          )}

          {loading ? (
            <SkeletonCards />
          ) : filteredProjects.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/40 bg-elevation-1 py-12 px-6 text-center">
              <Activity className="size-8 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">
                {searchFilter ? "No matching projects" : "No projects found. Start Claude Code to see projects here."}
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredProjects.map((project) => {
                const activeCount = activeCountByProject[project.dirName] || 0

                return (
                  <button
                    key={project.dirName}
                    onClick={() => onSelectProject?.(project.dirName)}
                    className={cn(
                      "card-glow group relative rounded-lg border elevation-1 p-4 text-left transition-smooth",
                      "hover:bg-elevation-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                      activeCount > 0
                        ? "border-l-[3px] border-l-green-500 border-t-border/40 border-r-border/40 border-b-border/40"
                        : "border-border/40"
                    )}
                  >
                    <div className="flex items-center gap-2.5 mb-2">
                      <FolderOpen className="size-4 shrink-0 text-muted-foreground group-hover:text-blue-400 transition-colors" />
                      <span className="text-sm font-medium text-foreground truncate flex-1">
                        {projectName(project.path)}
                      </span>
                      <ChevronRight className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                    </div>

                    <p className="text-[11px] text-muted-foreground mb-3 truncate font-mono">
                      {shortPath(project.path)}
                    </p>

                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <FileText className="size-3" />
                        {project.sessionCount} {project.sessionCount === 1 ? "session" : "sessions"}
                      </span>
                      {activeCount > 0 && (
                        <span className="flex items-center gap-1 text-green-400">
                          <LiveDot size="sm" />
                          {activeCount} active
                        </span>
                      )}
                      {project.lastModified && (
                        <span className="flex items-center gap-1 ml-auto shrink-0">
                          <Clock className="size-3" />
                          {formatRelativeTime(project.lastModified)}
                        </span>
                      )}
                    </div>

                    {activeCount > 0 && (
                      <span className="absolute top-3 right-3">
                        <LiveDot />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Keyboard shortcuts */}
        <div className="mt-6 rounded-lg border border-border/40 bg-elevation-1 px-5 py-4">
          <div className="flex items-center gap-2 mb-3">
            <Keyboard className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Keyboard Shortcuts</span>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[11px]">
            <Shortcut keys={["Space"]} label="Focus chat input" />
            <Shortcut keys={["Ctrl", "B"]} label="Toggle sidebar" />
            <Shortcut keys={["Ctrl", "E"]} label="Expand all turns" />
            <Shortcut keys={["Ctrl", "Shift", "E"]} label="Collapse all turns" />
            <Shortcut keys={isMac ? ["\u2303", "\u2318", "T"] : ["Ctrl", "Alt", "T"]} label="Open terminal" />
            <Shortcut keys={isMac ? ["\u2303", "\u2318", "N"] : ["Ctrl", "Alt", "N"]} label="Switch project" />
            <Shortcut keys={isMac ? ["\u2303", "\u2318", "S"] : ["Ctrl", "Alt", "S"]} label="Switch theme" />
            <Shortcut keys={["\u2303", "Tab"]} label="Recent session (back)" />
            <Shortcut keys={["\u2303", "Shift", "Tab"]} label="Recent session (forward)" />
            <Shortcut keys={["Ctrl", "Shift", "\u2191 / \u2193"]} label="Navigate live sessions" />
            <Shortcut keys={["Ctrl", "Shift", "1\u20139"]} label="Jump to Nth live session" />
            <Shortcut keys={["Ctrl", "Shift", "M"]} label="Toggle voice input" />
            <Shortcut keys={["Esc"]} label="Clear search" />
          </div>
        </div>

      </div>
    </ScrollArea>
  )
}
