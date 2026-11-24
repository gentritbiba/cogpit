import { Activity, StrictMode } from "react"
import { render, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { OpenRequest, OpenTarget, SessionController } from "@/lib/sessionLoader"
import type { SessionShellState } from "../useSessionState"

/** A controller that, like the real one, lets no open land after `leave()` or `suspend()`. */
vi.mock("@/lib/sessionLoader", () => ({
  createSessionController: () => {
    let token = 0
    let shown: { dirName: string; fileName: string } | null = null
    let suspended: { dirName: string; fileName: string } | null = null
    const controller: SessionController = {
      openSession: vi.fn(async (target: OpenTarget, { commit }: OpenRequest) => {
        const mine = ++token
        const address = typeof target === "function" ? await target(new AbortController().signal) : target
        await Promise.resolve()
        if (mine !== token) return "superseded"
        shown = address
        commit({ parsed: { sessionId: "s1", turns: [] } as never, source: { ...address, watchOffset: 0, loadId: 1 } })
        return "opened"
      }),
      prefetchSession: vi.fn(),
      reloadCurrent: vi.fn(async () => {}),
      leave: vi.fn(() => { token++; shown = null; suspended = null }),
      suspend: vi.fn(() => { token++; suspended = shown; shown = null }),
      resume: vi.fn(() => { if (suspended && !shown) shown = suspended; suspended = null }),
      showing: vi.fn(() => shown),
    }
    return controller
  },
}))

import { useSessionController } from "../useSessionController"
import { useUrlSync } from "../useUrlSync"

const parse = vi.fn()

describe("useSessionController", () => {
  it("suspends the session on unmount, so its screen and any open in flight go with the shell", () => {
    const { result, unmount } = renderHook(() => useSessionController(vi.fn(), parse))
    const { sessions } = result.current

    unmount()

    expect(sessions.suspend).toHaveBeenCalledOnce()
  })

  it("keeps the session of a machine's pane shown again, without opening it again", async () => {
    window.history.replaceState(null, "", "/my-project/session-123")
    const dispatchState = vi.fn()
    const state = { sessionSource: null, pendingDirName: null, mainView: "sessions", dashboardProject: null } as unknown as SessionShellState
    let controller: SessionController | null = null
    function Shell() {
      const { sessions, dispatch } = useSessionController(dispatchState, parse)
      controller = sessions
      useUrlSync({ state, dispatch, isMobile: false, resetTurnCount: vi.fn(), scrollToBottomInstant: vi.fn(), sessions })
      return null
    }
    const { rerender } = render(<Activity mode="visible"><Shell /></Activity>)
    await vi.waitFor(() => expect(dispatchState).toHaveBeenCalledWith(expect.objectContaining({ type: "LOAD_SESSION" })))

    rerender(<Activity mode="hidden"><Shell /></Activity>)
    rerender(<Activity mode="visible"><Shell /></Activity>)
    await Promise.resolve()

    expect(controller!.suspend).toHaveBeenCalled()
    expect(controller!.resume).toHaveBeenCalled()
    expect(controller!.openSession).toHaveBeenCalledOnce()
    expect(controller!.showing()).toEqual(expect.objectContaining({ dirName: "my-project", fileName: "session-123.jsonl" }))
    window.history.replaceState(null, "", "/")
  })

  it("still opens a deep link when StrictMode remounts the shell's effects", async () => {
    window.history.replaceState(null, "", "/my-project/session-123")
    const dispatchState = vi.fn()
    const state = { sessionSource: null, pendingDirName: null, mainView: "sessions", dashboardProject: null } as unknown as SessionShellState
    function Shell() {
      const { sessions, dispatch } = useSessionController(dispatchState, parse)
      useUrlSync({ state, dispatch, isMobile: false, resetTurnCount: vi.fn(), scrollToBottomInstant: vi.fn(), sessions })
      return null
    }
    render(<StrictMode><Shell /></StrictMode>)

    await vi.waitFor(() => expect(dispatchState).toHaveBeenCalledWith(expect.objectContaining({
      type: "LOAD_SESSION",
      source: expect.objectContaining({ dirName: "my-project", fileName: "session-123.jsonl" }),
    })))
    window.history.replaceState(null, "", "/")
  })
})
