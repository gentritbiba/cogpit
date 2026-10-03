/**
 * Panel/sidebar toggle state for the App shell.
 */

import { useState, useCallback, useEffect, useRef, startTransition } from "react"
import { useLocalStorage } from "./useLocalStorage"
import { useMainViews } from "@/edition/hooks"
import type { MainView, SessionState, SessionAction } from "./useSessionState"
import { canonicalPluginPanelId } from "@/plugins/panelAliases"
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
  showWorkflows: boolean
  activeWorkspacePanel: string | null
  showProjectSwitcher: boolean
  showThemeSelector: boolean

  handleToggleSidebar: () => void
  toggleWorkspacePanel: (panelId: string) => void
  openWorkspacePanel: (panelId: string) => void
  closeWorkspacePanel: () => void
  handleToggleConfig: () => void
  handleToggleMission: () => void
  /** Opens the edition main view `id` names. */
  openMainView: (id: string) => void
  closeMainView: () => void
  handleEditConfig: (filePath: string) => void
  handleOpenProjectSwitcher: () => void
  handleCloseProjectSwitcher: () => void
  handleToggleThemeSelector: () => void
  handleCloseThemeSelector: () => void

  setShowWorkflows: React.Dispatch<React.SetStateAction<boolean>>
}

const CLOSE_MAIN_VIEW = {
  config: { type: "CLOSE_CONFIG" },
  mission: { type: "CLOSE_MISSION" },
  extension: { type: "CLOSE_EXTENSION_VIEW" },
} as const satisfies Record<Exclude<MainView, "sessions">, SessionAction>

function initialWorkspacePanel(): string | null {
  if (typeof window === "undefined") return BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges
  try {
    if (JSON.parse(localStorage.getItem("panel-worktrees-visible") ?? "false") === true) {
      return BUILT_IN_WORKSPACE_PANEL_IDS.worktrees
    }
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
  const { mainView } = state

  const handleToggleSidebar = useCallback(() => {
    startTransition(() => setShowSidebar(!showSidebar))
  }, [setShowSidebar, showSidebar])
  const toggleWorkspacePanel = useCallback((panelId: string) => {
    startTransition(() => {
      const returningToSessions = mainView !== "sessions"
      if (returningToSessions) dispatch(CLOSE_MAIN_VIEW[mainView])
      setStoredWorkspacePanel((current) => (
        returningToSessions || canonicalPluginPanelId(current) !== canonicalPluginPanelId(panelId) ? panelId : null
      ))
    })
  }, [dispatch, setStoredWorkspacePanel, mainView])
  const openWorkspacePanel = useCallback((panelId: string) => {
    startTransition(() => {
      if (mainView !== "sessions") dispatch(CLOSE_MAIN_VIEW[mainView])
      setStoredWorkspacePanel(panelId)
    })
  }, [dispatch, setStoredWorkspacePanel, mainView])
  const closeWorkspacePanel = useCallback(() => {
    startTransition(() => setStoredWorkspacePanel(null))
  }, [setStoredWorkspacePanel])
  const handleToggleConfig = useCallback(() => {
    const closing = mainView === "config"
    startTransition(() => {
      dispatch({ type: closing ? "CLOSE_CONFIG" : "OPEN_CONFIG" })
    })
  }, [mainView, dispatch])
  const handleToggleMission = useCallback(() => {
    const closing = mainView === "mission"
    startTransition(() => {
      dispatch({ type: closing ? "CLOSE_MISSION" : "OPEN_MISSION" })
    })
  }, [mainView, dispatch])
  const openMainView = useCallback((id: string) => {
    startTransition(() => dispatch({ type: "OPEN_EXTENSION_VIEW", id }))
  }, [dispatch])
  const closeMainView = useCallback(() => {
    startTransition(() => dispatch({ type: "CLOSE_EXTENSION_VIEW" }))
  }, [dispatch])
  // Each main view is asked once, as soon as the caller may open it, whether
  // the app should start in it, until one does.
  const mainViews = useMainViews()
  const askedToOpenOnStart = useRef(new Set<string>())
  const openedOnStart = useRef(false)
  useEffect(() => {
    if (openedOnStart.current) return
    const asked = askedToOpenOnStart.current
    for (const view of mainViews) {
      if (asked.has(view.id)) continue
      asked.add(view.id)
      if (view.openOnStart?.()) {
        openedOnStart.current = true
        openMainView(view.id)
        return
      }
    }
  }, [mainViews, openMainView])
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
    showWorkflows,
    activeWorkspacePanel,
    showProjectSwitcher,
    showThemeSelector,
    handleToggleSidebar,
    toggleWorkspacePanel,
    openWorkspacePanel,
    closeWorkspacePanel,
    handleToggleConfig,
    handleToggleMission,
    openMainView,
    closeMainView,
    handleEditConfig,
    handleOpenProjectSwitcher,
    handleCloseProjectSwitcher,
    handleToggleThemeSelector,
    handleCloseThemeSelector,
    setShowWorkflows,
  }
}
