import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"
import { useProcessPanel } from "@/hooks/useProcessPanel"
import {
  registerBuiltInFileOpener,
  resolveBuiltInEditorTarget,
  type BuiltInEditorRequest,
  type FileOpenTarget,
  type ProjectRef,
} from "@/lib/fileOpener"

interface UseProjectWorkspaceOptions {
  sessionId: string | null | undefined
  sessionCwd: string | null | undefined
  pendingPath: string | null
  sessionDirName: string | null | undefined
  pendingDirName: string | null
  dashboardProject: string | null
  /**
   * Whether this shell renders the file workspace. Layouts without it (mobile)
   * decline built-in open requests so they fall through to the host editor.
   */
  supportsFileWorkspace: boolean
}

type RightWorkspace =
  | { kind: "preview"; cwd: string }
  | {
      kind: "project-files"
      /** Directory the panel browses — usually, but not always, the project. */
      root: string
      /** Project the panel belongs to; it hides while another one is active. */
      anchorCwd: string | null
      request: BuiltInEditorRequest | null
    }

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
  supportsFileWorkspace,
}: UseProjectWorkspaceOptions) {
  const processPanel = useProcessPanel(sessionId)
  const [rightWorkspace, setRightWorkspace] = useState<RightWorkspace | null>(null)
  const [launchTerminalRequest, setLaunchTerminalRequest] = useState(0)
  const requestTokenRef = useRef(0)

  const currentCwd = sessionCwd ?? pendingPath ?? undefined
  const showPreview = Boolean(
    currentCwd && rightWorkspace?.kind === "preview" && rightWorkspace.cwd === currentCwd,
  )
  // The panel stays mounted for the project it was opened from, so switching
  // sessions hides it rather than repointing it at unrelated files.
  const projectFiles = rightWorkspace?.kind === "project-files"
    && rightWorkspace.anchorCwd === (currentCwd ?? null)
    ? rightWorkspace
    : null

  /** The project a pending (not yet started) session would run in. */
  const pendingProject = useMemo<ProjectRef>(
    () => ({ path: pendingPath, dirName: pendingDirName }),
    [pendingPath, pendingDirName],
  )

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
    startTransition(() => {
      setRightWorkspace(showPreview ? null : { kind: "preview", cwd: currentCwd })
    })
  }, [currentCwd, showPreview])

  const handleToggleProjectFiles = useCallback(() => {
    if (!currentCwd) return
    startTransition(() => {
      setRightWorkspace(projectFiles ? null : {
        kind: "project-files",
        root: currentCwd,
        anchorCwd: currentCwd,
        request: null,
      })
    })
  }, [currentCwd, projectFiles])

  /** Serve an "open in editor" request from the built-in file workspace. */
  const openInFileWorkspace = useCallback((target: FileOpenTarget): boolean => {
    if (!supportsFileWorkspace) return false
    const resolved = resolveBuiltInEditorTarget(target, currentCwd)
    if (!resolved) return false
    requestTokenRef.current += 1
    const token = requestTokenRef.current
    startTransition(() => setRightWorkspace({
      kind: "project-files",
      root: resolved.root,
      anchorCwd: currentCwd ?? null,
      request: resolved.file
        ? { file: resolved.file, mode: resolved.mode, line: resolved.line, token }
        : null,
    }))
    return true
  }, [currentCwd, supportsFileWorkspace])

  useEffect(() => registerBuiltInFileOpener(openInFileWorkspace), [openInFileWorkspace])

  const closeRightWorkspace = useCallback(() => {
    startTransition(() => setRightWorkspace(null))
  }, [])

  return {
    processPanel,
    currentCwd,
    showPreview,
    showProjectFiles: projectFiles !== null,
    projectFilesRoot: projectFiles?.root,
    projectFilesRequest: projectFiles?.request ?? null,
    launchTerminalRequest,
    pendingProject,
    handleOpenTerminal,
    handleMcpAuth,
    handleToggleIntegratedTerminal,
    handleNewIntegratedTerminal,
    handleTogglePreview,
    handleToggleProjectFiles,
    closeRightWorkspace,
  }
}
