import { Fragment, useMemo } from "react"
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
import { ProjectFavicon } from "@/components/ProjectFavicon"
import { cn } from "@/lib/utils"
import { formatRelativeTime, shortPath, projectName } from "@/lib/format"
import { useProjectNames } from "@/hooks/useProjectNames"
import { ProjectContextMenu } from "@/components/ProjectContextMenu"
import {
  DEVICE_CYCLE_COMMAND,
  DEVICE_SWITCH_COMMANDS,
  KEYBINDING_DEFINITIONS,
  KEYBINDING_GROUPS,
  formatShortcut,
  shortcutLabel,
  type KeybindingCommand,
  type KeybindingShortcut,
} from "@/lib/keybindings"
import { SearchInput, ErrorBanner, SkeletonCards, LiveDot, Shortcut } from "./DashboardWidgets"

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

/**
 * Device switching has its own switcher UI plus nine near-identical chords, so
 * the quick card leaves that family to the full shortcuts dialog.
 */
const DEVICE_COMMANDS = new Set<KeybindingCommand>([...DEVICE_SWITCH_COMMANDS, DEVICE_CYCLE_COMMAND])

/**
 * The only two chords that cannot live in the keybinding registry, so they are
 * the only two spelled out here. Session jump matches on `event.code` (the
 * registry compares `event.key`, which Shift turns into a symbol), and Escape
 * has no editable-target guard, so allowing a rebind to a printable key would
 * clear the search on every keystroke. Every other chord is generated from the
 * registry above — repeating one here would leave a stale row after a rebind.
 */
const FIXED_SHORTCUTS: { shortcut: KeybindingShortcut; label: string }[] = [
  { shortcut: { key: "1\u20139", modKey: true, shiftKey: true }, label: "Jump to Nth live session" },
  { shortcut: { key: "escape" }, label: "Clear search" },
]

interface ShortcutSection {
  title: string
  rows: { id: string; keys: string; label: string }[]
}

/**
 * Chords that only fire once a particular panel is already open, so they are
 * noise on a dashboard where no panel is. They stay in the full reference that
 * `?` opens; this card is a starting point, not a manual.
 */
const PANEL_SUBACTIONS = new Set<KeybindingCommand>([
  "newIntegratedTerminal",
  "closeIntegratedTerminal",
  "previewRefresh",
  "previewFocusUrl",
  "previewZoomIn",
  "previewZoomOut",
  "previewResetZoom",
  "projectFileSave",
])

/**
 * The cheat sheet, read out of the keybinding registry so a rebind shows up
 * here too. Called during render rather than memoized because the resolved
 * chords change the moment the user edits them.
 */
function buildShortcutSections(): ShortcutSection[] {
  return [
    ...KEYBINDING_GROUPS.map((group) => ({
      title: group,
      rows: KEYBINDING_DEFINITIONS
        .filter((definition) =>
          definition.group === group
          && !DEVICE_COMMANDS.has(definition.command)
          && !PANEL_SUBACTIONS.has(definition.command))
        .map((definition) => ({
          id: definition.command,
          keys: shortcutLabel(definition.command),
          label: definition.label,
        })),
    })),
    {
      title: "Navigation",
      rows: FIXED_SHORTCUTS.map((item) => ({
        id: item.label,
        keys: formatShortcut(item.shortcut),
        label: item.label,
      })),
    },
  ]
}

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

  const { names: projectNames, rename: renameProject } = useProjectNames()

  const shortcutSections = buildShortcutSections()

  const filteredProjects = useMemo(() => {
    if (!searchFilter) return projects
    const q = searchFilter.toLowerCase()
    return projects.filter(
      (p) =>
        p.path.toLowerCase().includes(q) ||
        p.shortName.toLowerCase().includes(q) ||
        (projectNames[p.dirName]?.toLowerCase().includes(q))
    )
  }, [projects, searchFilter, projectNames])

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-6 sm:py-8 fade-in">
        {/* Header */}
        <div className="mb-4 sm:mb-8">
          <div className="flex items-center gap-2 sm:gap-3 mb-1 sm:mb-2">
            <Cog className="size-5 sm:size-7 text-blue-400" />
            <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-foreground">
              Cogpit
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground">Session Viewer & Monitor</p>
        </div>

        {/* Projects Section */}
        <div className="mb-4 sm:mb-8">
          <div className="flex items-center gap-3 mb-3 sm:mb-4">
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
                {searchFilter ? "No matching projects" : "No projects found. Start Claude Code or Codex to see projects here."}
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredProjects.map((project) => {
                const activeCount = activeCountByProject[project.dirName] || 0
                const custom = projectNames[project.dirName]

                return (
                  <ProjectContextMenu
                    key={project.dirName}
                    projectLabel={projectName(project.path)}
                    customName={custom}
                    onRename={(name) => renameProject(project.dirName, name)}
                  >
                    <button
                      onClick={() => onSelectProject?.(project.dirName)}
                      className={cn(
                        "card-glow group relative rounded-lg elevation-1 p-4 text-left transition-smooth",
                        "hover:bg-elevation-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                        activeCount > 0 && "border-l-[3px] border-l-green-500"
                      )}
                    >
                      <div className="flex items-center gap-2.5 mb-2">
                        <ProjectFavicon
                          projectPath={project.path}
                          className="size-4"
                          fallback={
                            <FolderOpen className="size-4 shrink-0 text-muted-foreground group-hover:text-blue-400 transition-colors" />
                          }
                        />
                        <span className="text-sm font-medium text-foreground truncate flex-1">
                          {custom || projectName(project.path)}
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
                  </ProjectContextMenu>
                )
              })}
            </div>
          )}
        </div>

        {/* Keyboard shortcuts (hidden on mobile — not useful for touch) */}
        <div className="mt-6 rounded-lg bg-elevation-1 px-5 py-4 hidden sm:block">
          <div className="flex items-center gap-2 mb-3">
            <Keyboard className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Keyboard Shortcuts</span>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[11px]">
            {shortcutSections.map((section) => (
              <Fragment key={section.title}>
                <div className="col-span-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  {section.title}
                </div>
                {section.rows.map((row) => (
                  <Shortcut key={row.id} keys={row.keys} label={row.label} />
                ))}
              </Fragment>
            ))}
            <div className="col-span-2 pt-2 text-[10px] text-muted-foreground/60">
              {shortcutLabel("keyboardShortcuts")} shows every shortcut, including the ones scoped to a panel.
            </div>
          </div>
        </div>

      </div>
    </ScrollArea>
  )
}
