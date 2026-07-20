import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CommandPalette,
  type CommandPaletteProject,
  type CommandPaletteProps,
  type CommandPaletteSession,
} from "@/components/CommandPalette"
import { usePty } from "@/contexts/PtyContext"
import { authFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"
import { copyToClipboard } from "@/lib/utils"
import type { ProcessEntry } from "@/hooks/useProcessPanel"

interface CommandPaletteHostProps extends Omit<
  CommandPaletteProps,
  | "projects"
  | "recentSessions"
  | "loadingNavigation"
  | "onOpenIntegratedTerminal"
  | "onOpenProjectInEditor"
  | "onRevealProject"
  | "onCopyProjectPath"
> {
  currentProjectDirName: string | null
  projectCwd: string | null
  onProcessStarted: (entry: ProcessEntry) => void
  launchTerminalRequest?: number
}

async function fetchArray<T>(url: string, signal: AbortSignal): Promise<T[]> {
  const response = await authFetch(url, { signal })
  if (!response.ok) throw new Error(`Request failed (${response.status})`)
  const data: unknown = await response.json()
  return Array.isArray(data) ? data as T[] : []
}

export function CommandPaletteHost({
  open,
  currentProjectDirName,
  projectCwd,
  onProcessStarted,
  launchTerminalRequest = 0,
  ...paletteProps
}: CommandPaletteHostProps) {
  const pty = usePty()
  const [projects, setProjects] = useState<CommandPaletteProject[]>([])
  const [recentSessions, setRecentSessions] = useState<CommandPaletteSession[]>([])
  const [loadingNavigation, setLoadingNavigation] = useState(false)
  const handledTerminalRequestRef = useRef(0)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoadingNavigation(true)

    Promise.allSettled([
      fetchArray<CommandPaletteProject>("/api/projects", controller.signal),
      fetchArray<CommandPaletteSession>("/api/active-sessions?limit=12&perProject=3", controller.signal),
    ]).then(([projectResult, sessionResult]) => {
      if (controller.signal.aborted) return
      setProjects(projectResult.status === "fulfilled" ? projectResult.value : [])
      setRecentSessions(sessionResult.status === "fulfilled" ? sessionResult.value : [])
      setLoadingNavigation(false)
    })

    return () => controller.abort()
  }, [open])

  const terminalCwd = useMemo(() => {
    if (projectCwd) return projectCwd
    if (!currentProjectDirName) return null
    return projects.find((project) => project.dirName === currentProjectDirName)?.path ?? null
  }, [currentProjectDirName, projectCwd, projects])

  const handleOpenIntegratedTerminal = useCallback(() => {
    if (!terminalCwd) return
    const id = pty.spawnTerminal({ cwd: terminalCwd })
    const name = terminalCwd.replace(/\/+$/, "").split("/").at(-1) || "Terminal"
    onProcessStarted({
      id,
      name,
      type: "terminal",
      status: "running",
      source: terminalCwd,
    })
  }, [onProcessStarted, pty, terminalCwd])

  useEffect(() => {
    if (
      launchTerminalRequest <= handledTerminalRequestRef.current
      || !terminalCwd
      || pty.status !== "connected"
    ) return
    handledTerminalRequestRef.current = launchTerminalRequest
    handleOpenIntegratedTerminal()
  }, [handleOpenIntegratedTerminal, launchTerminalRequest, pty.status, terminalCwd])

  const postProjectAction = useCallback((endpoint: string) => {
    if (!terminalCwd && !currentProjectDirName) return
    void authFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: terminalCwd ?? undefined,
        dirName: currentProjectDirName ?? undefined,
      }),
    })
  }, [currentProjectDirName, terminalCwd])

  const handleOpenProjectInEditor = useCallback(() => {
    postProjectAction("/api/open-in-editor")
  }, [postProjectAction])

  const handleRevealProject = useCallback(() => {
    postProjectAction("/api/reveal-in-folder")
  }, [postProjectAction])

  const handleCopyProjectPath = useCallback(() => {
    if (terminalCwd) void copyToClipboard(terminalCwd)
  }, [terminalCwd])

  return (
    <CommandPalette
      {...paletteProps}
      open={open}
      projects={projects}
      recentSessions={recentSessions}
      loadingNavigation={loadingNavigation}
      onOpenIntegratedTerminal={
        terminalCwd && pty.status === "connected"
          ? handleOpenIntegratedTerminal
          : undefined
      }
      onOpenProjectInEditor={terminalCwd && !isRemoteDeviceActive() ? handleOpenProjectInEditor : undefined}
      onRevealProject={terminalCwd && !isRemoteDeviceActive() ? handleRevealProject : undefined}
      onCopyProjectPath={terminalCwd ? handleCopyProjectPath : undefined}
    />
  )
}
