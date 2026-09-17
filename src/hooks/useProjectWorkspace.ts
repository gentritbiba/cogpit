import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { openProjectTerminal } from "@/lib/openTerminal"
import { useProcessPanel } from "@/hooks/useProcessPanel"
import {
  registerBuiltInFileOpener,
  resolveBuiltInEditorTarget,
  type BuiltInEditorRequest,
  type FileOpenTarget,
  type ProjectRef,
} from "@/lib/fileOpener"
import { BUILT_IN_WORKSPACE_PANEL_IDS } from "@/plugins/builtInPanelIds"

interface UseProjectWorkspaceOptions {
  sessionId: string | null | undefined
  sessionCwd: string | null | undefined
  pendingPath: string | null
  sessionDirName: string | null | undefined
  pendingDirName: string | null
  dashboardProject: string | null
  /** Whether this viewer can access the host's file workspace. */
  supportsFileWorkspace: boolean
  activeWorkspacePanel: string | null
  openWorkspacePanel: (panelId: string) => void
  closeWorkspacePanel: () => void
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
  activeWorkspacePanel,
  openWorkspacePanel,
  closeWorkspacePanel,
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

  const terminalTarget = useCallback(() => ({
    path: sessionCwd ?? pendingPath ?? undefined,
    dirName: sessionDirName ?? pendingDirName ?? dashboardProject ?? undefined,
  }), [sessionCwd, pendingPath, sessionDirName, pendingDirName, dashboardProject])

  const handleOpenTerminal = useCallback(() => {
    openProjectTerminal(terminalTarget())
  }, [terminalTarget])

  const handleMcpAuth = useCallback((_serverName: string) => {
    openProjectTerminal({ ...terminalTarget(), command: "claude /mcp" })
  }, [terminalTarget])

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
      closeWorkspacePanel()
      setRightWorkspace(showPreview ? null : { kind: "preview", cwd: currentCwd })
    })
  }, [closeWorkspacePanel, currentCwd, showPreview])

  const handleToggleProjectFiles = useCallback(() => {
    if (!currentCwd) return
    if (activeWorkspacePanel === BUILT_IN_WORKSPACE_PANEL_IDS.projectFiles) {
      closeWorkspacePanel()
      return
    }
    startTransition(() => {
      setRightWorkspace({
        kind: "project-files",
        root: currentCwd,
        anchorCwd: currentCwd,
        request: null,
      })
      openWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.projectFiles)
    })
  }, [activeWorkspacePanel, closeWorkspacePanel, currentCwd, openWorkspacePanel])

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
    openWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.projectFiles)
    return true
  }, [currentCwd, openWorkspacePanel, supportsFileWorkspace])

  useEffect(() => registerBuiltInFileOpener(openInFileWorkspace), [openInFileWorkspace])

  const closeRightWorkspace = useCallback(() => {
    startTransition(() => setRightWorkspace(null))
  }, [])

  return {
    processPanel,
    currentCwd,
    showPreview,
    showProjectFiles: Boolean(
      currentCwd && activeWorkspacePanel === BUILT_IN_WORKSPACE_PANEL_IDS.projectFiles,
    ),
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
