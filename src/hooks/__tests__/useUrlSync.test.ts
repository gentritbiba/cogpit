import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"

vi.mock("@/lib/sessionLoader", () => ({
  loadSessionTailCached: vi.fn(),
}))

import { loadSessionTailCached } from "@/lib/sessionLoader"
import type { ParsedSession } from "@/lib/types"
import { useUrlSync } from "../useUrlSync"
import type { SessionState } from "../useSessionState"

const mockedLoadTail = vi.mocked(loadSessionTailCached)

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

function loadedSession(dirName: string, fileName: string) {
  return {
    parsed: { turns: [{ index: 0 }] } as unknown as ParsedSession,
    source: { dirName, fileName, rawText: "", watchOffset: 100 },
  }
}

describe("useUrlSync", () => {
  const dispatch = vi.fn()
  const resetTurnCount = vi.fn()
  const scrollToBottomInstant = vi.fn()
  const workerParse = vi.fn()

  function renderUrlSync(state: SessionState = makeState()) {
    return renderHook(() =>
      useUrlSync({
        state,
        dispatch,
        isMobile: false,
        resetTurnCount,
        scrollToBottomInstant,
        workerParse,
      })
    )
  }

  beforeEach(() => {
    vi.resetAllMocks()
    sessionStorage.clear()
    // Reset URL to root
    window.history.replaceState(null, "", "/")
  })

  it("does not load from URL when at root path", () => {
    renderUrlSync()

    // No session load dispatched for root path
    expect(dispatch).not.toHaveBeenCalled()
  })

  it("loads session from URL on mount when path has session", async () => {
    window.history.replaceState(null, "", "/my-project/session-123")

    mockedLoadTail.mockResolvedValueOnce(loadedSession("my-project", "session-123.jsonl"))

    renderUrlSync()

    // Wait for async load — tail-loaded via the shared session loader
    await vi.waitFor(() => {
      expect(mockedLoadTail).toHaveBeenCalledWith(
        "my-project",
        "session-123.jsonl",
        workerParse,
        "session",
      )
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "LOAD_SESSION",
          source: expect.objectContaining({ watchOffset: 100 }),
        })
      )
    })
  })

  it("dispatches SET_DASHBOARD_PROJECT for project-only path", async () => {
    window.history.replaceState(null, "", "/my-project")

    renderUrlSync()

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SET_DASHBOARD_PROJECT", dirName: "my-project" })
      )
    })
  })

  it("dispatches SELECT_TEAM for team path", async () => {
    window.history.replaceState(null, "", "/team/my-team")

    renderUrlSync()

    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "SELECT_TEAM", teamName: "my-team" })
      )
    })
  })

  it("dispatches GO_HOME when session load fails", async () => {
    window.history.replaceState(null, "", "/proj/bad-session")

    mockedLoadTail.mockRejectedValueOnce(new Error("Failed to load session (404)"))

    renderUrlSync()

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

    renderUrlSync(state)

    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/proj-a/sess-1")
    pushStateSpy.mockRestore()
  })

  it("pushes team URL when team is selected", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState")

    const state = makeState({
      mainView: "teams",
      selectedTeam: "alpha-team",
    })

    renderUrlSync(state)

    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/team/alpha-team")
    pushStateSpy.mockRestore()
  })

  it("pushes project URL for dashboardProject", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState")

    const state = makeState({
      dashboardProject: "my-project",
    })

    renderUrlSync(state)

    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/my-project")
    pushStateSpy.mockRestore()
  })

  it("pushes project URL for a pending session before it is finalized", () => {
    const pushStateSpy = vi.spyOn(window.history, "pushState")

    const state = makeState({
      pendingDirName: "pending-project",
    })

    renderUrlSync(state)

    expect(pushStateSpy).toHaveBeenCalledWith(null, "", "/pending-project")
    pushStateSpy.mockRestore()
  })

  it("handles popstate event (browser back/forward)", async () => {
    window.history.replaceState(null, "", "/")

    const { unmount } = renderUrlSync()

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

      mockedLoadTail.mockResolvedValueOnce(loadedSession("-Users-foo", "uuid.jsonl"))

      renderUrlSync()

      // The device segment is stripped; the load targets the remainder only.
      await vi.waitFor(() => {
        expect(mockedLoadTail).toHaveBeenCalledWith(
          "-Users-foo",
          "uuid.jsonl",
          workerParse,
          "session",
        )
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ type: "LOAD_SESSION" })
        )
      })
    })

    it("treats /d/<id>/ as the device home (no session load)", () => {
      window.history.replaceState(null, "", "/d/dev_x/")

      renderUrlSync()

      expect(dispatch).not.toHaveBeenCalled()
    })

    it("parses a project-only device path /d/<id>/<dirName>", async () => {
      window.history.replaceState(null, "", "/d/dev_x/-Users-foo")

      renderUrlSync()

      await vi.waitFor(() => {
        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({ type: "SET_DASHBOARD_PROJECT", dirName: "-Users-foo" })
        )
      })
    })

    it("parses a device-scoped team path /d/<id>/team/<name>", async () => {
      window.history.replaceState(null, "", "/d/dev_x/team/alpha")

      renderUrlSync()

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

      renderUrlSync(state)

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

      mockedLoadTail.mockResolvedValueOnce(loadedSession("-Users-foo", "uuid.jsonl"))

      renderUrlSync()

      await vi.waitFor(() => {
        expect(mockedLoadTail).toHaveBeenCalledWith(
          "-Users-foo",
          "uuid.jsonl",
          workerParse,
          "session",
        )
      })
    })

    it("restores device context on popstate to a /d/<id> deep link", async () => {
      window.history.replaceState(null, "", "/")

      const { unmount } = renderUrlSync()

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
