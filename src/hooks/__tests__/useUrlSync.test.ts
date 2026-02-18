import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

vi.mock("@/lib/parser", () => ({
  parseSession: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { parseSession } from "@/lib/parser"
import type { ParsedSession } from "@/lib/types"
import { useUrlSync } from "../useUrlSync"
import type { SessionState } from "../useSessionState"

const mockedAuthFetch = vi.mocked(authFetch)
const mockedParseSession = vi.mocked(parseSession)

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session: null,
    sessionSource: null,
    selectedTurnIndex: null,
    sidebarOpen: true,
    mainView: "dashboard",
    dashboardProject: null,
    selectedTeam: null,
    ...overrides,
  } as SessionState
}

describe("useUrlSync", () => {
  const dispatch = vi.fn()
  const resetTurnCount = vi.fn()
  const scrollToBottomInstant = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    // Reset URL to root
    window.history.replaceState(null, "", "/")
  })

  it("does not load from URL when at root path", () => {
    renderHook(() =>
      useUrlSync({
        state: makeState(),
        dispatch,
        isMobile: false,
        resetTurnCount,
        scrollToBottomInstant,
      })
    )

    // No session load dispatched for root path
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("loads session from URL on mount when path has session", async () => {
    window.history.replaceState(null, "", "/my-project/session-123")

    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '{"type":"user"}\n',
    } as Response)
    mockedParseSession.mockReturnValueOnce({ turns: [{ index: 0 }] } as unknown as ParsedSession)

    renderHook(() =>
      useUrlSync({
        state: makeState(),
        dispatch,
        isMobile: false,
        resetTurnCount,
        scrollToBottomInstant,
      })
    )

    // Wait for async load
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOAD_SESSION" })
      )
    })
  })

  it("dispatches SET_DASHBOARD_PROJECT for project-only path", async () => {
    window.history.replaceState(null, "", "/my-project")

    renderHook(() =>
      useUrlSync({
        state: makeState(),
        dispatch,
        isMobile: false,
        resetTurnCount,
        scrollToBottomInstant,
      })
    )

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_DASHBOARD_PROJECT", dirName: "my-project" })
      )
    })
  })

  it("dispatches SELECT_TEAM for team path", async () => {
    window.history.replaceState(null, "", "/team/my-team")

    renderHook(() =>
      useUrlSync({
        state: makeState(),
        dispatch,
        isMobile: false,
        resetTurnCount,
        scrollToBottomInstant,
      })
    )

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SELECT_TEAM", teamName: "my-team" })
      )
    })
  })

  it("dispatches GO_HOME when session fetch fails", async () => {
    window.history.replaceState(null, "", "/proj/bad-session")

    mockedAuthFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response)

    renderHook(() =>
      useUrlSync({
        state: makeState(),
        dispatch,
        isMobile: false,
        resetTurnCount,
        scrollToBottomInstant,
      })
    )

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "GO_HOME" })
      )
    })
  })

  it("pushes URL state when sessionSource changes", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState")

    const state = makeState({
      sessionSource: { dirName: "proj-a", fileName: "sess-1.jsonl", rawText: "" },
    })

    renderHook(() =>
      useUrlSync({
        state,
        dispatch,
        isMobile: false,
        resetTurnCount,
        scrollToBottomInstant,
      })
    )

    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/proj-a/sess-1")
    pushStateSpy.mockRestore()
  })

  it("pushes team URL when team is selected", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState")

    const state = makeState({
      mainView: "teams",
      selectedTeam: "alpha-team",
    })

    renderHook(() =>
      useUrlSync({
        state,
        dispatch,
        isMobile: false,
        resetTurnCount,
        scrollToBottomInstant,
      })
    )

    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/team/alpha-team")
    pushStateSpy.mockRestore()
  })

  it("pushes project URL for dashboardProject", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState")

    const state = makeState({
      dashboardProject: "my-project",
    })

    renderHook(() =>
      useUrlSync({
        state,
        dispatch,
        isMobile: false,
        resetTurnCount,
        scrollToBottomInstant,
      })
    )

    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/my-project")
    pushStateSpy.mockRestore()
  })

  it("handles popstate event (browser back/forward)", async () => {
    window.history.replaceState(null, "", "/")

    const { unmount } = renderHook(() =>
      useUrlSync({
        state: makeState(),
        dispatch,
        isMobile: false,
        resetTurnCount,
        scrollToBottomInstant,
      })
    )

    // Simulate navigating to a team URL then pressing "back"
    window.history.pushState(null, "", "/team/test-team")
    window.dispatchEvent(new PopStateEvent("popstate"))

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SELECT_TEAM", teamName: "test-team" })
      )
    })

    unmount()
    // Reset URL for next test
    window.history.replaceState(null, "", "/")
  })
})
