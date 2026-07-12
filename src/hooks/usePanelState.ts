/**
 * Panel/sidebar toggle state for the App shell.
 */

import { useState, useCallback } from "react"
import type { SessionState, SessionAction } from "./useSessionState"

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
  const [showSidebar, setShowSidebar] = useState(true)
  const [showStats, setShowStats] = useState(false)
  const [showWorktrees, setShowWorktrees] = useState(false)
  const [showWorkflows, setShowWorkflows] = useState(false)
  const [showFileChanges, setShowFileChanges] = useState(true)
  const [showProjectSwitcher, setShowProjectSwitcher] = useState(false)
  const [showThemeSelector, setShowThemeSelector] = useState(false)

  const handleToggleSidebar = useCallback(() => setShowSidebar((p) => !p), [])
  const handleToggleStats = useCallback(() => setShowStats((p) => !p), [])
  const handleToggleWorktrees = useCallback(() => setShowWorktrees((p) => !p), [])
  const handleToggleWorkflows = useCallback(() => setShowWorkflows((p) => !p), [])
  const handleToggleFileChanges = useCallback(() => setShowFileChanges((p) => !p), [])
  const handleToggleConfig = useCallback(() => {
    if (state.mainView === "config") {
      dispatch({ type: "CLOSE_CONFIG" })
    } else {
      dispatch({ type: "OPEN_CONFIG" })
    }
  }, [state.mainView, dispatch])
  const handleEditConfig = useCallback((filePath: string) => {
    dispatch({ type: "OPEN_CONFIG", filePath })
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
