import { useMemo, memo } from "react"
import { FolderOpen, ChevronRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { formatRelativeTime, shortPath } from "@/lib/format"
import type { ProjectInfo } from "./types"

// ── Props ──────────────────────────────────────────────────────────────────

interface ProjectsListProps {
  projects: ProjectInfo[]
  filter: string
  onSelectProject: (p: ProjectInfo) => void
  isMobile?: boolean
}

// ── Component ──────────────────────────────────────────────────────────────

export const ProjectsList = memo(function ProjectsList({
  projects,
  filter,
  onSelectProject,
  isMobile,
}: ProjectsListProps): React.ReactElement {
  const filtered = useMemo(() => {
    if (!filter) return projects
    const q = filter.toLowerCase()
    return projects.filter(
      (p) =>
        p.path.toLowerCase().includes(q) ||
        p.shortName.toLowerCase().includes(q)
    )
  }, [projects, filter])

  if (filtered.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-xs text-muted-foreground">
        {filter ? "No matching projects" : "No projects found"}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-1.5 px-2 pb-3">
        {filtered.map((project) => (
          <button
            key={project.dirName}
            onClick={() => onSelectProject(project)}
            className={cn(
              "group flex flex-col gap-1 rounded-lg px-2.5 text-left transition-colors elevation-2 depth-low border border-border/40 hover:bg-elevation-3 card-hover",
              isMobile ? "py-3 min-h-[44px]" : "py-2"
            )}
          >
            <div className="flex items-center gap-2">
              <FolderOpen className="size-3.5 shrink-0 text-muted-foreground group-hover:text-blue-400" />
              <span className="text-xs font-medium text-foreground truncate">
                {shortPath(project.path, 2)}
              </span>
              <ChevronRight className="size-3 ml-auto shrink-0 text-muted-foreground group-hover:text-muted-foreground" />
            </div>
            <div className="ml-5.5 flex items-center gap-2 text-[10px] text-muted-foreground">
              <Badge
                variant="secondary"
                className="h-4 px-1 text-[10px] font-normal"
              >
                {project.sessionCount} sessions
              </Badge>
              {project.lastModified && (
                <span>{formatRelativeTime(project.lastModified)}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    </ScrollArea>
  )
})
