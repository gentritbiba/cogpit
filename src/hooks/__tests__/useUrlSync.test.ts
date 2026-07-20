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
    sessionStorage.clear()
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

  it("pushes project URL for a pending session before it is finalized", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState")

    const state = makeState({
      pendingDirName: "pending-project",
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

    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/pending-project")
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

  // ── Device-scoped URLs (/d/:deviceId) ────────────────────────────────────
  describe("/d/:deviceId prefix", () => {
    it("parses a deep link /d/<id>/<dirName>/<sessionId> against the remainder", async () => {
      window.history.replaceState(null, "", "/d/dev_x/-Users-foo/uuid")

      mockedAuthFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '{"type":"user"}\n',
      } as Response)
      mockedParseSession.mockReturnValueOnce({ turns: [] } as unknown as ParsedSession)

      renderHook(() =>
        useUrlSync({
          state: makeState(),
          dispatch,
          isMobile: false,
          resetTurnCount,
          scrollToBottomInstant,
        })
      )

      // The device segment is stripped; the API call targets the remainder only.
      await vi.waitFor(() => {
        expect(mockedAuthFetch).toHaveBeenCalledWith(
          "/api/sessions/-Users-foo/uuid.jsonl"
        )
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ type: "LOAD_SESSION" })
        )
      })
    })

    it("treats /d/<id>/ as the device home (no session load)", () => {
      window.history.replaceState(null, "", "/d/dev_x/")

      renderHook(() =>
        useUrlSync({
          state: makeState(),
          dispatch,
          isMobile: false,
          resetTurnCount,
          scrollToBottomInstant,
        })
      )

      expect(dispatch).not.toHaveBeenCalled()
    })

    it("parses a project-only device path /d/<id>/<dirName>", async () => {
      window.history.replaceState(null, "", "/d/dev_x/-Users-foo")

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
          expect.objectContaining({ type: "SET_DASHBOARD_PROJECT", dirName: "-Users-foo" })
        )
      })
    })

    it("parses a device-scoped team path /d/<id>/team/<name>", async () => {
      window.history.replaceState(null, "", "/d/dev_x/team/alpha")

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
          expect.objectContaining({ type: "SELECT_TEAM", teamName: "alpha" })
        )
      })
    })

    it("emits a /d/<id>-prefixed path and remembers it when a remote device is active", () => {
      window.history.replaceState(null, "", "/d/dev_x/")
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

      expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/d/dev_x/proj-a/sess-1")
      expect(sessionStorage.getItem("cogpit-last-path::dev_x")).toBe(
        "/d/dev_x/proj-a/sess-1"
      )
      pushStateSpy.mockRestore()
    })

    it("keeps unprefixed dirName routes local (no device swallowed)", async () => {
      // A claude dirName starts with "-", a codex one with "codex__" — neither
      // collides with the "/d/" prefix, so these stay on the local device.
      window.history.replaceState(null, "", "/-Users-foo/uuid")

      mockedAuthFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => '{"type":"user"}\n',
      } as Response)
      mockedParseSession.mockReturnValueOnce({ turns: [] } as unknown as ParsedSession)

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
        expect(mockedAuthFetch).toHaveBeenCalledWith(
          "/api/sessions/-Users-foo/uuid.jsonl"
        )
      })
    })

    it("restores device context on popstate to a /d/<id> deep link", async () => {
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

      window.history.pushState(null, "", "/d/dev_x/-Users-foo")
      window.dispatchEvent(new PopStateEvent("popstate"))

      await vi.waitFor(() => {
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ type: "SET_DASHBOARD_PROJECT", dirName: "-Users-foo" })
        )
      })

      unmount()
      window.history.replaceState(null, "", "/")
    })
  })
})
