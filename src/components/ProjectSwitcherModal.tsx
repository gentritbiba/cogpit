import { useState, useEffect, useMemo, useCallback } from "react"
import { FolderOpen, FolderPlus } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { authFetch } from "@/lib/auth"
import { shortPath } from "@/lib/format"
import { useProjectNames } from "@/hooks/useProjectNames"
import { findClaudeProjectDirNameForCwd } from "@/lib/sessionSource"
import type { AgentKind } from "@/lib/sessionSource"
import { matchesKeybinding } from "@/lib/keybindings"

interface ProjectInfo {
  dirName: string
  path: string
  shortName: string
  sessionCount: number
  lastModified: string | null
}

const AGENT_LABELS: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "GitHub Copilot",
}


interface ProjectSwitcherModalProps {
  open: boolean
  onClose: () => void
  onNewSession: (dirName: string, cwd?: string) => void
  onNewFolder: (cwd: string) => void
  defaultAgentKind: AgentKind
  currentProjectDirName: string | null
  currentProjectCwd: string | null
}

export function ProjectSwitcherModal({
  open,
  onClose,
  onNewSession,
  onNewFolder,
  defaultAgentKind,
  currentProjectDirName,
  currentProjectCwd,
}: ProjectSwitcherModalProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [filter, setFilter] = useState("")

  // Load projects when modal opens
  useEffect(() => {
    if (!open) return
    setFilter("")
    authFetch("/api/projects")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: ProjectInfo[]) => setProjects(data))
      .catch(() => setProjects([]))
  }, [open])

  // Second press of the shortcut while modal is open → new session in current project
  useEffect(() => {
    if (!open) return
    function handleShortcut(e: KeyboardEvent) {
      if (matchesKeybinding("newSession", e) && currentProjectDirName) {
        e.preventDefault()
        const resolvedDirName = currentProjectCwd
          ? (
            findClaudeProjectDirNameForCwd(projects, currentProjectCwd)
            ?? projects.find((project) => project.path === currentProjectCwd)?.dirName
            ?? currentProjectDirName
          )
          : currentProjectDirName
        onNewSession(resolvedDirName, currentProjectCwd ?? undefined)
        onClose()
      }
    }
    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [open, projects, currentProjectDirName, currentProjectCwd, onNewSession, onClose])

  const { names: projectNames } = useProjectNames()

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
  const normalizedFolderPath = folderPath.replace(/[\\/]+$/, "") || folderPath
  const isAbsoluteFolderPath = folderPath.startsWith("/")
    || /^[a-z]:[\\/]/i.test(folderPath)
    || folderPath.startsWith("\\\\")
  const canAddFolder = isAbsoluteFolderPath && !projects.some((project) => {
    const normalizedProjectPath = project.path.replace(/[\\/]+$/, "") || project.path
    return normalizedProjectPath === normalizedFolderPath
  })
  const handleSelect = useCallback(
    (project: ProjectInfo) => {
      onNewSession(project.dirName, project.path)
      onClose()
    },
    [onNewSession, onClose]
  )

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Start a session</DialogTitle>
          <DialogDescription>Choose a project or enter an absolute folder path.</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} className="rounded-none p-0">
          <CommandInput
            autoFocus
            placeholder="Search projects or paste an absolute path..."
            value={filter}
            onValueChange={setFilter}
          />
          <CommandList className="max-h-80 p-1">
            <CommandEmpty className="py-0">
              <Empty className="border-0 py-8">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
                  <EmptyTitle>No projects found</EmptyTitle>
                  <EmptyDescription>Try another name or paste an absolute path.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </CommandEmpty>
            <CommandGroup className="p-0">
              {canAddFolder && (
                <CommandItem
                  value={`folder:${folderPath}`}
                  className="motion-list-item h-auto gap-3 px-3 py-2.5"
                  onSelect={() => {
                    onNewFolder(folderPath)
                    onClose()
                  }}
                >
                  <FolderPlus data-icon="inline-start" className="size-4 shrink-0 text-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">Start in this folder</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {folderPath} · {AGENT_LABELS[defaultAgentKind]}
                    </div>
                  </div>
                </CommandItem>
              )}
              {filtered.map((project) => (
                <CommandItem
                  key={project.dirName}
                  value={`project:${project.dirName}`}
                  className="motion-list-item h-auto gap-3 px-3 py-2.5"
                  onSelect={() => handleSelect(project)}
                >
                  <FolderOpen data-icon="inline-start" className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {projectNames[project.dirName] || shortPath(project.path)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {projectNames[project.dirName] && (
                        <span className="mr-1.5">{shortPath(project.path)}</span>
                      )}
                      {project.sessionCount} session{project.sessionCount !== 1 ? "s" : ""}
                      {project.lastModified && (
                        <> &middot; {new Date(project.lastModified).toLocaleDateString()}</>
                      )}
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
