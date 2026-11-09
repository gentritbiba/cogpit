import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useSessionSelector, useSessionState } from "@/hooks/useSessionState"
import { makeTurn } from "@/__tests__/fixtures"
import { EMPTY_SESSION_DIGEST, type SessionView } from "../../../shared/session/sessionDigest"

function session(turns = [makeTurn({ id: "t1" })]): SessionView {
  return {
    sessionId: "s1", version: "1", gitBranch: "main", cwd: "/repo", slug: "", name: "", model: "opus", turns,
    stats: {
      totalInputTokens: 0, totalOutputTokens: 0, totalCacheCreationTokens: 0, totalCacheReadTokens: 0,
      toolCallCounts: {}, errorCount: 0, totalDurationMs: 0, turnCount: turns.length,
    },
    digest: EMPTY_SESSION_DIGEST,
  }
}

const SOURCE = { dirName: "d", fileName: "s1.jsonl", watchOffset: 0, loadId: 1 }

describe("useSessionSelector", () => {
  it("runs a stable selector again only when the open session changes", () => {
    const select = vi.fn((open: SessionView | null) => open?.turns.length ?? 0)
    const { result, rerender } = renderHook(() => {
      const [, dispatch, store] = useSessionState()
      return { dispatch, count: useSessionSelector(store, select) }
    })
    act(() => result.current.dispatch({ type: "LOAD_SESSION", session: session(), source: SOURCE, isMobile: false }))
    const runs = select.mock.calls.length

    rerender()
    act(() => result.current.dispatch({ type: "SET_SEARCH_QUERY", value: "needle" }))
    act(() => result.current.dispatch({ type: "OPEN_CONFIG" }))
    expect(select).toHaveBeenCalledTimes(runs)

    act(() => result.current.dispatch({ type: "LOAD_SESSION", session: session([makeTurn({ id: "t1" }), makeTurn({ id: "t2" })]), source: SOURCE, isMobile: false }))
    expect(select).toHaveBeenCalledTimes(runs + 1)
    expect(result.current.count).toBe(2)
  })
})
