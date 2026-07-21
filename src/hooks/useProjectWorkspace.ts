import { useCallback, useState } from "react"
import { authFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"
import { useProcessPanel } from "@/hooks/useProcessPanel"

interface UseProjectWorkspaceOptions {
  sessionId: string | null | undefined
  sessionCwd: string | null | undefined
  pendingPath: string | null
  sessionDirName: string | null | undefined
  pendingDirName: string | null
  dashboardProject: string | null
}

type RightWorkspace = {
  kind: "preview" | "project-files"
  cwd: string
}

type PendingProjectActionEndpoint = "/api/open-in-editor" | "/api/reveal-in-folder"

/**
 * Coordinates the project-scoped surfaces and native actions around the chat:
 * process terminals, preview/files panes, and editor/terminal launch requests.
 */
export function useProjectWorkspace({
  sessionId,
  sessionCwd,
  pendingPath,
  sessionDirName,
  pendingDirName,
  dashboardProject,
}: UseProjectWorkspaceOptions) {
  const processPanel = useProcessPanel(sessionId)
  const [rightWorkspace, setRightWorkspace] = useState<RightWorkspace | null>(null)
  const [launchTerminalRequest, setLaunchTerminalRequest] = useState(0)

  const currentCwd = sessionCwd ?? pendingPath ?? undefined
  const showPreview = Boolean(
    currentCwd && rightWorkspace?.kind === "preview" && rightWorkspace.cwd === currentCwd,
  )
  const showProjectFiles = Boolean(
    currentCwd && rightWorkspace?.kind === "project-files" && rightWorkspace.cwd === currentCwd,
  )

  /** Fire-and-forget POST for actions exposed on a pending project. */
  const postProjectAction = useCallback((endpoint: PendingProjectActionEndpoint) => {
    authFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: pendingPath || undefined, dirName: pendingDirName || undefined }),
    }).catch(() => {})
  }, [pendingPath, pendingDirName])

  const handleOpenTerminal = useCallback(() => {
    // Native terminal windows can only be opened on the local device.
    if (isRemoteDeviceActive()) { console.warn("[open-terminal] unavailable for remote devices"); return }
    const projectPath = sessionCwd ?? pendingPath ?? undefined
    const dirName = sessionDirName ?? pendingDirName ?? dashboardProject ?? undefined
    if (!projectPath && !dirName) { console.warn("[open-terminal] no project path available"); return }
    authFetch("/api/open-terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, dirName }),
    }).then((res) => {
      if (!res.ok) res.json().then((data) => console.error("[open-terminal]", data.error)).catch(() => {})
    }).catch((error) => console.error("[open-terminal] fetch failed:", error))
  }, [sessionCwd, pendingPath, sessionDirName, pendingDirName, dashboardProject])

  const handleMcpAuth = useCallback((_serverName: string) => {
    if (isRemoteDeviceActive()) { console.warn("[mcp-auth] unavailable for remote devices"); return }
    const projectPath = sessionCwd ?? pendingPath ?? undefined
    const dirName = sessionDirName ?? pendingDirName ?? dashboardProject ?? undefined
    if (!projectPath && !dirName) return
    authFetch("/api/open-terminal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, dirName, command: "claude /mcp" }),
    }).catch((error) => console.error("[mcp-auth] open-terminal failed:", error))
  }, [sessionCwd, pendingPath, sessionDirName, pendingDirName, dashboardProject])

  const handleToggleIntegratedTerminal = useCallback(() => {
    const terminals = [...processPanel.processes.values()].filter((entry) => entry.type === "terminal")
    const terminal = terminals.at(-1)
    if (!terminal) {
      if (sessionCwd ?? pendingPath) {
        setLaunchTerminalRequest((request) => request + 1)
      }
      return
    }
    if (processPanel.activeProcessId === terminal.id && !processPanel.collapsed) {
      processPanel.toggleCollapse()
    } else {
      processPanel.setActive(terminal.id)
    }
  }, [pendingPath, processPanel, sessionCwd])

  const handleNewIntegratedTerminal = useCallback(() => {
    if (sessionCwd ?? pendingPath) {
      setLaunchTerminalRequest((request) => request + 1)
    }
  }, [pendingPath, sessionCwd])

  const handleTogglePreview = useCallback(() => {
    if (!currentCwd) return
    setRightWorkspace((current) =>
      current?.kind === "preview" && current.cwd === currentCwd
        ? null
        : { kind: "preview", cwd: currentCwd },
    )
  }, [currentCwd])

  const handleToggleProjectFiles = useCallback(() => {
    if (!currentCwd) return
    setRightWorkspace((current) =>
      current?.kind === "project-files" && current.cwd === currentCwd
        ? null
        : { kind: "project-files", cwd: currentCwd },
    )
  }, [currentCwd])

  const closeRightWorkspace = useCallback(() => {
    setRightWorkspace(null)
  }, [])

  return {
    processPanel,
    currentCwd,
    showPreview,
    showProjectFiles,
    launchTerminalRequest,
    postProjectAction,
    handleOpenTerminal,
    handleMcpAuth,
    handleToggleIntegratedTerminal,
    handleNewIntegratedTerminal,
    handleTogglePreview,
    handleToggleProjectFiles,
    closeRightWorkspace,
  }
}
