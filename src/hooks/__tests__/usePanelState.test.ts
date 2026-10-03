import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { Users } from "lucide-react"

import { usePanelState } from "../usePanelState"
import type { EditionMainView } from "@/edition/contract"
import { __installEditionUiForTest, __resetEditionUiForTest } from "@/edition/registry"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"
import { ALL_CAPABILITIES } from "../../../shared/contracts/identity"
import type { SessionState } from "../useSessionState"
import { BUILT_IN_WORKSPACE_PANEL_IDS } from "@/plugins/builtInPanelIds"

const state = { mainView: "sessions" } as SessionState

function render() {
  return renderHook(() => usePanelState(state, vi.fn()))
}

beforeEach(() => {
  localStorage.clear()
  __resetEditionUiForTest()
  __resetCapabilitiesForTest()
})

/** An edition main view that asks to open on start while `wantsToOpen` holds. */
function reportsView(wantsToOpen: () => boolean, available = true, id = "reports"): EditionMainView {
  return {
    id,
    label: "Reports",
    icon: Users,
    keywords: "reports",
    isAvailable: () => available,
    openOnStart: vi.fn(wantsToOpen),
    Component: () => null,
  }
}

describe("usePanelState", () => {
  it("starts in an edition main view that asks to, asking it once", async () => {
    const view = reportsView(() => true)
    __installEditionUiForTest({ mainViews: [view] })
    const dispatch = vi.fn()

    renderHook(() => usePanelState(state, dispatch))
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "OPEN_EXTENSION_VIEW", id: "reports" }))
    // A fresh identity hands the shell a new list of the same views.
    act(() => setMe({ authenticated: true, edition: "personal", user: null, capabilities: ALL_CAPABILITIES }))

    expect(view.openOnStart).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it("asks no later view once one opens", async () => {
    const first = reportsView(() => true)
    const second = reportsView(() => true, true, "audit")
    __installEditionUiForTest({ mainViews: [first, second] })
    const dispatch = vi.fn()

    renderHook(() => usePanelState(state, dispatch))
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: "OPEN_EXTENSION_VIEW", id: "reports" }))
    act(() => setMe({ authenticated: true, edition: "personal", user: null, capabilities: ALL_CAPABILITIES }))

    expect(second.openOnStart).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it("never asks a view the caller may not open", async () => {
    const view = reportsView(() => true, false)
    __installEditionUiForTest({ mainViews: [view] })
    const dispatch = vi.fn()

    renderHook(() => usePanelState(state, dispatch))
    await Promise.resolve()

    expect(view.openOnStart).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("starts from the shipped defaults when nothing is stored", () => {
    const { result } = render()
    expect(result.current.showSidebar).toBe(true)
    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges)
    expect(result.current.showWorkflows).toBe(false)
  })

  it("restores panel visibility on the next launch", () => {
    const first = render()
    act(() => {
      first.result.current.handleToggleSidebar()
      first.result.current.openWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo)
    })
    first.unmount()

    const { result } = render()
    expect(result.current.showSidebar).toBe(false)
    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo)
  })

  it("falls back to the default when a stored value is corrupt", () => {
    localStorage.setItem("panel-sidebar-visible", "{not json")
    localStorage.setItem("workspace-panel-active", "{not json")
    const { result } = render()
    expect(result.current.showSidebar).toBe(true)
    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges)
  })

  it("never restores the transient overlays", () => {
    const first = render()
    act(() => {
      first.result.current.handleOpenProjectSwitcher()
      first.result.current.handleToggleThemeSelector()
    })
    expect(first.result.current.showProjectSwitcher).toBe(true)
    expect(first.result.current.showThemeSelector).toBe(true)
    first.unmount()

    const { result } = render()
    expect(result.current.showProjectSwitcher).toBe(false)
    expect(result.current.showThemeSelector).toBe(false)
  })

  it("keeps exactly one workspace panel active", () => {
    const { result } = render()

    act(() => {
      result.current.openWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.projectFiles)
    })
    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.projectFiles)

    act(() => {
      result.current.toggleWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo)
    })
    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo)

    act(() => {
      result.current.toggleWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo)
    })
    expect(result.current.activeWorkspacePanel).toBeNull()
  })

  it("returns to the session view when a workspace panel opens from Config", () => {
    const dispatch = vi.fn()
    const configState = { mainView: "config" } as SessionState
    const { result } = renderHook(() => usePanelState(configState, dispatch))

    act(() => {
      result.current.openWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.worktrees)
    })

    expect(dispatch).toHaveBeenCalledWith({ type: "CLOSE_CONFIG" })
    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.worktrees)
  })

  it("keeps a persisted panel open when its rail button is selected from Config", () => {
    const dispatch = vi.fn()
    const configState = { mainView: "config" } as SessionState
    const { result } = renderHook(() => usePanelState(configState, dispatch))

    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges)

    act(() => {
      result.current.toggleWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges)
    })

    expect(dispatch).toHaveBeenCalledWith({ type: "CLOSE_CONFIG" })
    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges)
  })

  it.each([
    ["config", { type: "CLOSE_CONFIG" }],
    ["mission", { type: "CLOSE_MISSION" }],
    ["extension", { type: "CLOSE_EXTENSION_VIEW" }],
  ] as const)("opens an already-selected panel when toggled from %s", (mainView, closeAction) => {
    const dispatch = vi.fn()
    const alternateState = { mainView } as SessionState
    const { result } = renderHook(() => usePanelState(alternateState, dispatch))

    act(() => {
      result.current.toggleWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges)
    })

    expect(dispatch).toHaveBeenCalledWith(closeAction)
    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.fileChanges)
  })

  it("opens an edition main view by id and closes it", () => {
    const dispatch = vi.fn()
    const { result } = renderHook(() => usePanelState({ mainView: "sessions" } as SessionState, dispatch))

    act(() => result.current.openMainView("reports"))
    act(() => result.current.closeMainView())

    expect(dispatch.mock.calls).toEqual([[{ type: "OPEN_EXTENSION_VIEW", id: "reports" }], [{ type: "CLOSE_EXTENSION_VIEW" }]])
  })

  it("migrates the legacy panel visibility preference", () => {
    localStorage.setItem("panel-stats-visible", "true")
    const { result } = render()

    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo)
  })

  it("migrates an open legacy worktree sheet into the workspace panel", () => {
    localStorage.setItem("panel-worktrees-visible", "true")
    const { result } = render()

    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.worktrees)
  })

  it("updates shell panels and lazy views without forcing synchronous commits", () => {
    const dispatch = vi.fn()
    const { result } = renderHook(() => usePanelState(state, dispatch))

    act(() => {
      result.current.handleToggleSidebar()
      result.current.openWorkspacePanel(BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo)
      result.current.handleToggleConfig()
    })

    expect(result.current.showSidebar).toBe(false)
    expect(result.current.activeWorkspacePanel).toBe(BUILT_IN_WORKSPACE_PANEL_IDS.sessionInfo)
    expect(dispatch).toHaveBeenCalledWith({ type: "OPEN_CONFIG" })
  })
})
