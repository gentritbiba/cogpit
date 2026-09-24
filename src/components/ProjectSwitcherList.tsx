import { useState, useEffect, useMemo, type ReactNode } from "react"
import { FolderOpen, FolderPlus, FolderSearch } from "lucide-react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { FolderBrowser } from "@/components/FolderBrowser"
import { ProjectFavicon } from "@/components/ProjectFavicon"
import { useFolderHostName } from "@/hooks/useFolderHostName"
import { authFetch } from "@/lib/auth"
import { shortPath } from "@/lib/format"
import { useProjectNames } from "@/hooks/useProjectNames"
import type { AgentKind } from "@/lib/agents"
import { agentSwitcherName } from "@/lib/agents/presentation"
import type { ProjectInfo } from "@/components/Dashboard/types"

const BROWSE_FOLDERS = "browse-folders"

function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, "") || path
}

/** Every project the server knows, fetched fresh each time `enabled` turns on. */
export function useProjectList(enabled: boolean): ProjectInfo[] {
  const [projects, setProjects] = useState<ProjectInfo[]>([])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    authFetch("/api/projects", { signal: controller.signal })
      .then(async (res): Promise<ProjectInfo[]> => (res.ok ? await res.json() : []))
      .then(setProjects)
      .catch(() => { if (!controller.signal.aborted) setProjects([]) })
    return () => controller.abort()
  }, [enabled])

  return projects
}

/** The project list, or the folder browser in its place. */
export type ProjectSwitcherView = "projects" | "folders"

interface ProjectSwitcherListProps {
  projects: ProjectInfo[]
  onNewSession: (dirName: string, cwd?: string) => void
  /** Starts a session in a folder nobody has opened yet: pasted, or picked in the folder browser. */
  onNewFolder: (cwd: string) => void
  defaultAgentKind: AgentKind
  /** The project already selected, ticked in the list. */
  currentPath?: string | null
  /** Which view it opens on; the project list by default. */
  initialView?: ProjectSwitcherView
  /** Shown under the project list, not under the folder browser. */
  children?: ReactNode
}

/**
 * The searchable project list behind every "start a session somewhere else"
 * surface. The shortcut modal and the headline popover both render this, so a
 * project looks and filters the same wherever the user reaches for it.
 */
export function ProjectSwitcherList({
  projects,
  onNewSession,
  onNewFolder,
  defaultAgentKind,
  currentPath,
  initialView = "projects",
  children,
}: ProjectSwitcherListProps) {
  const [view, setView] = useState(initialView)
  const [filter, setFilter] = useState("")
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const { names: projectNames } = useProjectNames()
  const hostName = useFolderHostName()

  const filtered = useMemo(() => {
    if (!filter) return projects
    const q = filter.toLowerCase()
    return projects.filter(
      (p) =>
        p.path.toLowerCase().includes(q) ||
        p.shortName.toLowerCase().includes(q) ||
        p.dirName.toLowerCase().includes(q) ||
        (projectNames[p.dirName]?.toLowerCase().includes(q))
    )
  }, [projects, filter, projectNames])

  const folderPath = filter.trim()
  const isAbsoluteFolderPath = folderPath.startsWith("/")
    || /^[a-z]:[\\/]/i.test(folderPath)
    || folderPath.startsWith("\\\\")
  const canAddFolder = isAbsoluteFolderPath
    && !projects.some((project) => normalizePath(project.path) === normalizePath(folderPath))
  const current = currentPath ? normalizePath(currentPath) : null
  // The projects arrive after the list opens, so until the user moves it the
  // highlight stays on the first entry rather than on "Browse folders", which
  // is alone in the list before they do.
  const values = [
    ...(canAddFolder ? [`folder:${folderPath}`] : []),
    ...filtered.map((project) => `project:${project.dirName}`),
    BROWSE_FOLDERS,
  ]
  const highlight = highlighted !== null && values.includes(highlighted) ? highlighted : values[0]

  if (view === "folders") {
    return (
      <FolderBrowser
        hostName={hostName}
        projectPaths={new Set(projects.map((project) => normalizePath(project.path)))}
        onStart={onNewFolder}
        onBack={() => setView("projects")}
      />
    )
  }

  return (
    <Command
      shouldFilter={false}
      value={highlight}
      onValueChange={setHighlighted}
      className="rounded-none p-0"
    >
      <CommandInput
        autoFocus
        placeholder="Search projects, paste a folder path, or browse"
        value={filter}
        onValueChange={setFilter}
      />
      <CommandList className="box-content max-h-80 p-1">
        {filtered.length === 0 && !canAddFolder && (
          <Empty className="border-0 py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
              <EmptyTitle>No projects found</EmptyTitle>
              <EmptyDescription>Try another name, paste an absolute path, or browse the folders.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <CommandGroup className="p-0">
          {canAddFolder && (
            <CommandItem
              value={`folder:${folderPath}`}
              className="motion-list-item h-auto gap-3 px-3 py-2.5"
              onSelect={() => onNewFolder(folderPath)}
            >
              <FolderPlus data-icon="inline-start" className="size-4 shrink-0 text-foreground" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Start in this folder</div>
                <div className="truncate text-xs text-muted-foreground">
                  {folderPath} · {agentSwitcherName(defaultAgentKind)}
                </div>
              </div>
            </CommandItem>
          )}
          {filtered.map((project) => {
            const customName = projectNames[project.dirName]
            const path = shortPath(project.path)
            return (
              <CommandItem
                key={project.dirName}
                value={`project:${project.dirName}`}
                data-checked={current !== null && normalizePath(project.path) === current}
                className="motion-list-item h-auto gap-3 px-3 py-2.5"
                onSelect={() => onNewSession(project.dirName, project.path)}
              >
                <ProjectFavicon
                  projectPath={project.path}
                  fallback={<FolderOpen data-icon="inline-start" className="size-4 shrink-0 text-muted-foreground" />}
                  className="size-4"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{customName || path}</div>
                  <div className="text-xs text-muted-foreground">
                    {customName && <span className="mr-1.5">{path}</span>}
                    {project.sessionCount} session{project.sessionCount !== 1 ? "s" : ""}
                    {project.lastModified && (
                      <> &middot; {new Date(project.lastModified).toLocaleDateString()}</>
                    )}
                  </div>
                </div>
              </CommandItem>
            )
          })}
        </CommandGroup>
        {/* Sticky at the foot of the scrolling list, over its padding, so it shows however many projects there are. */}
        <CommandGroup className="sticky -bottom-1 border-t bg-popover p-0 py-1">
          <CommandItem
            value={BROWSE_FOLDERS}
            className="h-auto gap-3 px-3 py-2.5"
            onSelect={() => setView("folders")}
          >
            <FolderSearch data-icon="inline-start" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {hostName ? `Browse folders on ${hostName}…` : "Browse folders…"}
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
      {children}
    </Command>
  )
}
