import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { FolderOpen, Search } from "lucide-react"
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
import { authFetch } from "@/lib/auth"
import { shortPath } from "@/lib/format"

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
  onNewSession: (dirName: string) => void
  currentProjectDirName: string | null
}

export function ProjectSwitcherModal({
  open,
  onClose,
  onNewSession,
  currentProjectDirName,
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
      .then((data: ProjectInfo[]) => setProjects(data.slice(0, 10)))
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
      if (e.ctrlKey && (e.metaKey || e.altKey) && e.key === "n" && currentProjectDirName) {
        e.preventDefault()
        onNewSession(currentProjectDirName)
        onClose()
      }
    }
    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [open, currentProjectDirName, onNewSession, onClose])

  const filtered = useMemo(() => {
    if (!filter) return projects
    const q = filter.toLowerCase()
    return projects.filter(
      (p) =>
        p.path.toLowerCase().includes(q) ||
        p.shortName.toLowerCase().includes(q) ||
        p.dirName.toLowerCase().includes(q)
    )
  }, [projects, filter])

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  const handleSelect = useCallback(
    (project: ProjectInfo) => {
      onNewSession(project.dirName)
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
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === "Enter") {
        e.preventDefault()
        const target = filtered[selectedIndex]
        if (target) handleSelect(target)
      }
    },
    [filtered, selectedIndex, handleSelect]
  )

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent
        className="max-w-md p-0 elevation-4 border-border/30 gap-0 overflow-hidden [&>button:last-child]:hidden"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Switch project..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border/70 bg-elevation-2 px-1.5 py-0.5 text-[10px] text-zinc-400 font-mono">
            ESC
          </kbd>
        </div>

        {/* Project list */}
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-zinc-500">
              No projects found
            </div>
          ) : (
            filtered.map((project, i) => (
              <button
                key={project.dirName}
                data-project-item
                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                  i === selectedIndex
                    ? "bg-elevation-2 text-zinc-100"
                    : "text-zinc-400 hover:bg-elevation-2 hover:text-zinc-200"
                }`}
                onClick={() => handleSelect(project)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <FolderOpen className="size-4 shrink-0 text-zinc-500" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {shortPath(project.path)}
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {project.sessionCount} session{project.sessionCount !== 1 ? "s" : ""}
                    {project.lastModified && (
                      <> &middot; {new Date(project.lastModified).toLocaleDateString()}</>
                    )}
                  </div>
                </div>
                {i === selectedIndex && (
                  <kbd className="hidden sm:inline-flex items-center rounded border border-border/70 bg-elevation-2 px-1.5 py-0.5 text-[10px] text-zinc-500 font-mono">
                    ↵
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
