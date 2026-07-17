import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { FolderOpen, FolderPlus, Search } from "lucide-react"
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
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
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Load projects when modal opens
  useEffect(() => {
    if (!open) return
    setFilter("")
    setSelectedIndex(0)
    authFetch("/api/projects")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: ProjectInfo[]) => setProjects(data))
      .catch(() => setProjects([]))
  }, [open])

  // Auto-focus input when modal opens
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
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
  const folderOffset = canAddFolder ? 1 : 0
  const selectableCount = filtered.length + folderOffset

  const handleSelect = useCallback(
    (project: ProjectInfo) => {
      onNewSession(project.dirName, project.path)
      onClose()
    },
    [onNewSession, onClose]
  )

  // Scroll selected item into view
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const items = container.querySelectorAll("[data-project-item]")
    const item = items[selectedIndex] as HTMLElement | undefined
    if (item) {
      item.scrollIntoView({ block: "nearest" })
    }
  }, [selectedIndex])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, Math.max(0, selectableCount - 1)))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === "Enter") {
        e.preventDefault()
        if (canAddFolder && selectedIndex === 0) {
          onNewFolder(folderPath)
          onClose()
          return
        }
        const target = filtered[selectedIndex - folderOffset]
        if (target) handleSelect(target)
      }
    },
    [canAddFolder, filtered, folderOffset, folderPath, handleSelect, onClose, onNewFolder, selectableCount, selectedIndex]
  )

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="max-w-md p-0 elevation-4 border-border/30 gap-0 overflow-hidden [&>button:last-child]:hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search projects or paste an absolute path..."
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value)
              setSelectedIndex(0)
            }}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border/70 bg-elevation-2 px-1.5 py-0.5 text-[10px] text-muted-foreground font-mono">
            ESC
          </kbd>
        </div>

        {/* Project list */}
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          {filtered.length === 0 && !canAddFolder ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No projects found
            </div>
          ) : (
            <>
              {canAddFolder && (
                <button
                  type="button"
                  data-project-item
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                    selectedIndex === 0
                      ? "bg-elevation-2 text-foreground"
                      : "text-muted-foreground hover:bg-elevation-2 hover:text-foreground"
                  }`}
                  onClick={() => {
                    onNewFolder(folderPath)
                    onClose()
                  }}
                  onMouseEnter={() => setSelectedIndex(0)}
                >
                  <FolderPlus className="size-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">Start in this folder</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {folderPath} · {defaultAgentKind === "codex" ? "Codex" : "Claude"}
                    </div>
                  </div>
                </button>
              )}
              {filtered.map((project, i) => {
                const itemIndex = i + folderOffset
                return (
              <button
                type="button"
                key={project.dirName}
                data-project-item
                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                  itemIndex === selectedIndex
                    ? "bg-elevation-2 text-foreground"
                    : "text-muted-foreground hover:bg-elevation-2 hover:text-foreground"
                }`}
                onClick={() => handleSelect(project)}
                onMouseEnter={() => setSelectedIndex(itemIndex)}
              >
                <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {projectNames[project.dirName] || shortPath(project.path)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {projectNames[project.dirName] && (
                      <span className="mr-1.5">{shortPath(project.path)}</span>
                    )}
                    {project.sessionCount} session{project.sessionCount !== 1 ? "s" : ""}
                    {project.lastModified && (
                      <> &middot; {new Date(project.lastModified).toLocaleDateString()}</>
                    )}
                  </div>
                </div>
                {itemIndex === selectedIndex && (
                  <kbd className="hidden sm:inline-flex items-center rounded border border-border/70 bg-elevation-2 px-1.5 py-0.5 text-[10px] text-muted-foreground font-mono">
                    ↵
                  </kbd>
                )}
              </button>
                )
              })}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
