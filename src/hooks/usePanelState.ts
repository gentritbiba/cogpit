/**
 * Panel/sidebar toggle state for the App shell.
 */

import { useState, useCallback, startTransition } from "react"
import { useLocalStorage } from "./useLocalStorage"
import type { SessionState, SessionAction } from "./useSessionState"
import { BUILT_IN_WORKSPACE_PANEL_IDS } from "@/plugins/builtInPanelIds"

/**
 * Panel visibility survives a relaunch. Values come back from localStorage
 * untyped, so anything that is not a boolean falls back to the default.
 *
 * The setter is wrapped as well as the getter: every caller toggles with a
 * functional update, which would otherwise be handed the raw stored value and
 * make the first click after a corrupt read a no-op.
 */
function usePersistedFlag(key: string, defaultValue: boolean) {
  const [stored, setStored] = useLocalStorage<boolean>(key, defaultValue)
  const value = typeof stored === "boolean" ? stored : defaultValue
  const setValue = useCallback(
    (next: boolean | ((previous: boolean) => boolean)) => {
      setStored((previous) => {
        const safe = typeof previous === "boolean" ? previous : defaultValue
        return typeof next === "function" ? next(safe) : next
      })
    },
    [setStored, defaultValue],
  )
  return [value, setValue] as const
}

interface PanelState {
  showSidebar: boolean
  showWorktrees: boolean
  showWorkflows: boolean
  activeWorkspacePanel: string | null
  showProjectSwitcher: boolean
  showThemeSelector: boolean

  handleToggleSidebar: () => void
  handleToggleWorktrees: () => void
  handleToggleWorkflows: () => void
  toggleWorkspacePanel: (panelId: string) => void
  openWorkspacePanel: (panelId: string) => void
  closeWorkspacePanel: () => void
  handleToggleConfig: () => void
  handleToggleMission: () => void
  handleEditConfig: (filePath: string) => void
  handleOpenProjectSwitcher: () => void
  handleCloseProjectSwitcher: () => void
  handleToggleThemeSelector: () => void
  handleCloseThemeSelector: () => void

  setShowSidebar: React.Dispatch<React.SetStateAction<boolean>>
  setShowWorktrees: React.Dispatch<React.SetStateAction<boolean>>
  setShowWorkflows: React.Dispatch<React.SetStateAction<boolean>>
}

function initialWorkspacePanel(): string | null {
  if (typeof window === "undefined") return BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges
  try {
    if (JSON.parse(localStorage.getItem("panel-stats-visible") ?? "false") === true) {
      return BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo
    }
    if (JSON.parse(localStorage.getItem("panel-file-changes-visible") ?? "true") === false) {
      return null
    }
  } catch {
    // Ignore corrupt legacy state and use the shipped default.
  }
  return BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges
}

export function usePanelState(
  state: SessionState,
  dispatch: React.Dispatch<SessionAction>,
): PanelState {
  const [showSidebar, setShowSidebar] = usePersistedFlag("panel-sidebar-visible", true)
  const [showWorktrees, setShowWorktrees] = usePersistedFlag("panel-worktrees-visible", false)
  const [showWorkflows, setShowWorkflows] = usePersistedFlag("panel-workflows-visible", false)
  const [storedWorkspacePanel, setStoredWorkspacePanel] = useLocalStorage<string | null>(
    "workspace-panel-active",
    initialWorkspacePanel(),
  )
  const activeWorkspacePanel = typeof storedWorkspacePanel === "string" || storedWorkspacePanel === null
    ? storedWorkspacePanel
    : initialWorkspacePanel()
  // Project switcher and theme selector are transient overlays, not layout.
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false)
  const [showThemeSelector, setShowThemeSelector] = useState(false)

  const handleToggleSidebar = useCallback(() => {
    startTransition(() => setShowSidebar(!showSidebar))
  }, [setShowSidebar, showSidebar])
  const handleToggleWorktrees = useCallback(() => setShowWorktrees((p) => !p), [setShowWorktrees])
  const handleToggleWorkflows = useCallback(() => setShowWorkflows((p) => !p), [setShowWorkflows])
  const toggleWorkspacePanel = useCallback((panelId: string) => {
    startTransition(() => {
      setStoredWorkspacePanel((current) => current === panelId ? null : panelId)
    })
  }, [setStoredWorkspacePanel])
  const openWorkspacePanel = useCallback((panelId: string) => {
    startTransition(() => setStoredWorkspacePanel(panelId))
  }, [setStoredWorkspacePanel])
  const closeWorkspacePanel = useCallback(() => {
    startTransition(() => setStoredWorkspacePanel(null))
  }, [setStoredWorkspacePanel])
  const handleToggleConfig = useCallback(() => {
    const closing = state.mainView === "config"
    startTransition(() => {
      dispatch({ type: closing ? "CLOSE_CONFIG" : "OPEN_CONFIG" })
    })
  }, [state.mainView, dispatch])
  const handleToggleMission = useCallback(() => {
    const closing = state.mainView === "mission"
    startTransition(() => {
      dispatch({ type: closing ? "CLOSE_MISSION" : "OPEN_MISSION" })
    })
  }, [state.mainView, dispatch])
  const handleEditConfig = useCallback((filePath: string) => {
    startTransition(() => {
      dispatch({ type: "OPEN_CONFIG", filePath })
    })
  }, [dispatch])
  const handleOpenProjectSwitcher = useCallback(() => setShowProjectSwitcher(true), [])
  const handleCloseProjectSwitcher = useCallback(() => setShowProjectSwitcher(false), [])
  const handleToggleThemeSelector = useCallback(() => setShowThemeSelector((p) => !p), [])
  const handleCloseThemeSelector = useCallback(() => setShowThemeSelector(false), [])

  return {
    showSidebar,
    showWorktrees,
    showWorkflows,
    activeWorkspacePanel,
    showProjectSwitcher,
    showThemeSelector,
    handleToggleSidebar,
    handleToggleWorktrees,
    handleToggleWorkflows,
    toggleWorkspacePanel,
    openWorkspacePanel,
    closeWorkspacePanel,
    handleToggleConfig,
    handleToggleMission,
    handleEditConfig,
    handleOpenProjectSwitcher,
    handleCloseProjectSwitcher,
    handleToggleThemeSelector,
    handleCloseThemeSelector,
    setShowSidebar,
    setShowWorktrees,
    setShowWorkflows,
  }
}
