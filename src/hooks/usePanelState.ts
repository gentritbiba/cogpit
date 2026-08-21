/**
 * Panel/sidebar toggle state for the App shell.
 */

import { useState, useCallback, startTransition } from "react"
import { useLocalStorage } from "./useLocalStorage"
import type { SessionState, SessionAction } from "./useSessionState"

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
  showStats: boolean
  showWorktrees: boolean
  showWorkflows: boolean
  showFileChanges: boolean
  showProjectSwitcher: boolean
  showThemeSelector: boolean

  handleToggleSidebar: () => void
  handleToggleStats: () => void
  handleToggleWorktrees: () => void
  handleToggleWorkflows: () => void
  handleToggleFileChanges: () => void
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
  setShowFileChanges: React.Dispatch<React.SetStateAction<boolean>>
}

export function usePanelState(
  state: SessionState,
  dispatch: React.Dispatch<SessionAction>,
): PanelState {
  const [showSidebar, setShowSidebar] = usePersistedFlag("panel-sidebar-visible", true)
  const [showStats, setShowStats] = usePersistedFlag("panel-stats-visible", false)
  const [showWorktrees, setShowWorktrees] = usePersistedFlag("panel-worktrees-visible", false)
  const [showWorkflows, setShowWorkflows] = usePersistedFlag("panel-workflows-visible", false)
  const [showFileChanges, setShowFileChanges] = usePersistedFlag("panel-file-changes-visible", true)
  // Project switcher and theme selector are transient overlays, not layout.
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false)
  const [showThemeSelector, setShowThemeSelector] = useState(false)

  const handleToggleSidebar = useCallback(() => {
    startTransition(() => setShowSidebar(!showSidebar))
  }, [setShowSidebar, showSidebar])
  const handleToggleStats = useCallback(() => {
    startTransition(() => setShowStats(!showStats))
  }, [setShowStats, showStats])
  const handleToggleWorktrees = useCallback(() => setShowWorktrees((p) => !p), [setShowWorktrees])
  const handleToggleWorkflows = useCallback(() => setShowWorkflows((p) => !p), [setShowWorkflows])
  const handleToggleFileChanges = useCallback(() => {
    startTransition(() => setShowFileChanges(!showFileChanges))
  }, [setShowFileChanges, showFileChanges])
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
    showStats,
    showWorktrees,
    showWorkflows,
    showFileChanges,
    showProjectSwitcher,
    showThemeSelector,
    handleToggleSidebar,
    handleToggleStats,
    handleToggleWorktrees,
    handleToggleWorkflows,
    handleToggleFileChanges,
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
    setShowFileChanges,
  }
}
