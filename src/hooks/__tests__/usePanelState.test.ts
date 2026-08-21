import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

import { usePanelState } from "../usePanelState"
import type { SessionState } from "../useSessionState"

const state = { mainView: "sessions" } as SessionState

function render() {
  return renderHook(() => usePanelState(state, vi.fn()))
}

beforeEach(() => {
  localStorage.clear()
})

describe("usePanelState", () => {
  it("starts from the shipped defaults when nothing is stored", () => {
    const { result } = render()
    expect(result.current.showSidebar).toBe(true)
    expect(result.current.showFileChanges).toBe(true)
    expect(result.current.showStats).toBe(false)
    expect(result.current.showWorktrees).toBe(false)
    expect(result.current.showWorkflows).toBe(false)
  })

  it("restores panel visibility on the next launch", () => {
    const first = render()
    act(() => {
      first.result.current.handleToggleSidebar()
      first.result.current.handleToggleStats()
      first.result.current.handleToggleFileChanges()
    })
    first.unmount()

    const { result } = render()
    expect(result.current.showSidebar).toBe(false)
    expect(result.current.showStats).toBe(true)
    expect(result.current.showFileChanges).toBe(false)
  })

  it("falls back to the default when a stored value is corrupt", () => {
    localStorage.setItem("panel-sidebar-visible", "{not json")
    localStorage.setItem("panel-stats-visible", '"maybe"')
    const { result } = render()
    expect(result.current.showSidebar).toBe(true)
    expect(result.current.showStats).toBe(false)
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

  it("recovers from a corrupt stored value on the first toggle, not the second", () => {
    // The setter is functional, so an unsanitized previous value made the first
    // click a no-op: !"maybe" is false, which is what it already showed.
    localStorage.setItem("panel-stats-visible", JSON.stringify("maybe"))
    const { result } = render()
    expect(result.current.showStats).toBe(false)

    act(() => {
      result.current.handleToggleStats()
    })
    expect(result.current.showStats).toBe(true)
  })

  it("updates shell panels and lazy views without forcing synchronous commits", () => {
    const dispatch = vi.fn()
    const { result } = renderHook(() => usePanelState(state, dispatch))

    act(() => {
      result.current.handleToggleSidebar()
      result.current.handleToggleStats()
      result.current.handleToggleConfig()
    })

    expect(result.current.showSidebar).toBe(false)
    expect(result.current.showStats).toBe(true)
    expect(dispatch).toHaveBeenCalledWith({ type: "OPEN_CONFIG" })
  })
})
