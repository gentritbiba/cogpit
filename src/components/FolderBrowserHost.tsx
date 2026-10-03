import { lazy, Suspense, useEffect, useState } from "react"
import type { AgentKind } from "@/lib/agents"
import { onFolderBrowserRequest } from "@/lib/folders"

const ProjectSwitcherModal = lazy(() => import("@/components/ProjectSwitcherModal").then((module) => ({ default: module.ProjectSwitcherModal })))

interface FolderBrowserHostProps {
  onNewSession: (dirName: string, cwd?: string) => void
  onNewFolder: (cwd: string) => void
  defaultAgentKind: AgentKind
}

/**
 * The project switcher, opened straight on the folder browser whenever
 * `openFolderBrowser()` is called: the home screen and the sidebar ask for it
 * without each holding the new-session handlers. Mounted once per app shell;
 * the switcher loads on the first request.
 */
export function FolderBrowserHost({ onNewSession, onNewFolder, defaultAgentKind }: FolderBrowserHostProps) {
  const [open, setOpen] = useState<boolean | null>(null)
  useEffect(() => onFolderBrowserRequest(() => setOpen(true)), [])

  if (open === null) return null
  return (
    <Suspense fallback={null}>
      <ProjectSwitcherModal
        open={open}
        onClose={() => setOpen(false)}
        onNewSession={onNewSession}
        onNewFolder={onNewFolder}
        defaultAgentKind={defaultAgentKind}
        currentProjectDirName={null}
        currentProjectCwd={null}
        initialView="folders"
      />
    </Suspense>
  )
}
