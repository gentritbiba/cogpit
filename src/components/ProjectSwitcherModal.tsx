import { useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ProjectSwitcherList, useProjectList, type ProjectSwitcherView } from "@/components/ProjectSwitcherList"
import { findProjectDirNameForCwd, type AgentKind } from "@/lib/agents"
import { matchesKeybinding } from "@/lib/keybindings"

interface ProjectSwitcherModalProps {
  open: boolean
  onClose: () => void
  onNewSession: (dirName: string, cwd?: string) => void
  onNewFolder: (cwd: string) => void
  defaultAgentKind: AgentKind
  currentProjectDirName: string | null
  currentProjectCwd: string | null
  /** Which view it opens on; the project list by default. */
  initialView?: ProjectSwitcherView
}

export function ProjectSwitcherModal({
  open,
  onClose,
  onNewSession,
  onNewFolder,
  defaultAgentKind,
  currentProjectDirName,
  currentProjectCwd,
  initialView,
}: ProjectSwitcherModalProps) {
  const projects = useProjectList(open)

  // Second press of the shortcut while modal is open → new session in current project
  useEffect(() => {
    if (!open) return
    function handleShortcut(e: KeyboardEvent) {
      if (matchesKeybinding("newSession", e) && currentProjectDirName) {
        e.preventDefault()
        const resolvedDirName = currentProjectCwd
          ? (
            findProjectDirNameForCwd(projects, currentProjectCwd, "claude")
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

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>Start a session</DialogTitle>
          <DialogDescription>Choose a project, enter an absolute folder path, or browse the folders.</DialogDescription>
        </DialogHeader>
        <ProjectSwitcherList
          projects={projects}
          currentPath={currentProjectCwd}
          onNewSession={(dirName, cwd) => { onNewSession(dirName, cwd); onClose() }}
          onNewFolder={(cwd) => { onNewFolder(cwd); onClose() }}
          defaultAgentKind={defaultAgentKind}
          initialView={initialView}
        />
      </DialogContent>
    </Dialog>
  )
}
