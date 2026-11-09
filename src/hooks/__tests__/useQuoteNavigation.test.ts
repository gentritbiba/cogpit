import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { QUOTE_SEARCH_PAGES, useQuoteNavigation } from "../useQuoteNavigation"
import type { ParsedSession, Turn } from "../../../shared/session/types"
import type { SessionSource } from "../useLiveSession"

const turn = (id: string, reply = `reply ${id}`) => ({ id, assistantText: [reply] }) as unknown as Turn
const session = (turns: Turn[]) => ({ turns }) as unknown as ParsedSession
const source = (turnId: string, fileName = "a.jsonl") => ({ dirName: "-repo", fileName, sessionId: "s", turnId })
const open = (fileName = "a.jsonl") => ({ dirName: "-repo", fileName, rawText: "" }) as SessionSource

function harness(initial: { turns: Turn[]; older: Turn[][]; open?: SessionSource }) {
  const state = { turns: initial.turns, older: [...initial.older], sessionSource: initial.open ?? open() }
  const jumpToTurn = vi.fn(async (_turnKey: string) => true)
  const loadSession = vi.fn()
  const layoutListeners = new Set<() => void>()
  const subscribeTimeline = (listener: () => void) => {
    layoutListeners.add(listener)
    return () => { layoutListeners.delete(listener) }
  }
  const laidOut = () => act(() => { for (const listener of layoutListeners) listener() })
  const view = renderHook(() => useQuoteNavigation({
    session: session(state.turns),
    sessionSource: state.sessionSource,
    loadSession,
    jumpToTurn,
    subscribeTimeline,
    hasMore: state.older.length > 0,
    // Like the real paging hook: the page arrives after a fetch, then the view renders it.
    loadMore: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const page = state.older.shift() ?? []
      state.turns = [...page, ...state.turns]
      act(() => view.rerender())
      return page.length
    },
  }))
  return { view, state, jumpToTurn, loadSession, laidOut }
}

describe("useQuoteNavigation", () => {
  it("pages older history in until it finds a quote's turn beyond the loaded tail", async () => {
    const { view, jumpToTurn } = harness({ turns: [turn("t9"), turn("t10")], older: [[turn("t7"), turn("t8")], [turn("t5"), turn("t6")]] })
    let found: boolean | undefined
    act(() => { void view.result.current(source("t5"), "reply t5").then((value) => { found = value }) })
    await waitFor(() => expect(found).toBe(true))
    // By key: t5 is index 0 now, and would not be after another page came in.
    expect(jumpToTurn).toHaveBeenCalledWith("t5")
  })

  it("finds a renumbered turn by the quoted text, and reports a deleted source without paging forever", async () => {
    const renumbered = harness({ turns: [turn("new-id", "the exact saved quote and more")], older: [] })
    let found: boolean | undefined
    act(() => { void renumbered.view.result.current(source("old-id"), "the exact saved quote").then((value) => { found = value }) })
    await waitFor(() => expect(found).toBe(true))
    expect(renumbered.jumpToTurn).toHaveBeenCalledWith("new-id")

    const pages = Array.from({ length: QUOTE_SEARCH_PAGES + 5 }, (_, i) => [turn(`older-${i}`)])
    const deleted = harness({ turns: [turn("t1")], older: pages })
    found = undefined
    act(() => { void deleted.view.result.current(source("gone"), "never written").then((value) => { found = value }) })
    await waitFor(() => expect(found).toBe(false))
    expect(deleted.state.older).toHaveLength(5)
    expect(deleted.jumpToTurn).not.toHaveBeenCalled()
  })

  it("opens the quote's own session first, and gives up when it never opens (denied or deleted)", async () => {
    vi.useFakeTimers()
    try {
      const { view, loadSession, jumpToTurn } = harness({ turns: [turn("t1")], older: [], open: open("other.jsonl") })
      let found: boolean | undefined
      const pending = view.result.current(source("t1"), "reply t1").then((value) => { found = value })
      expect(loadSession).toHaveBeenCalledWith("-repo", "a.jsonl")
      await act(async () => { vi.advanceTimersByTime(15_000) })
      await pending
      expect(found).toBe(false)
      expect(jumpToTurn).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it("jumps by turn key, which a prepend does not shift the way it shifts indices", async () => {
    const { view, jumpToTurn, state } = harness({ turns: [turn("t1"), turn("dup"), turn("dup")], older: [] })
    let found: boolean | undefined
    act(() => { void view.result.current(source("dup"), "reply dup").then((value) => { found = value }) })
    await waitFor(() => expect(found).toBe(true))
    expect(jumpToTurn).toHaveBeenCalledWith("dup")

    // A prepend moves every index; the key the list renders stays the same.
    state.turns = [turn("t0"), ...state.turns]
    act(() => view.rerender())
    jumpToTurn.mockClear()
    act(() => { void view.result.current(source("t1"), "reply t1").then((value) => { found = value }) })
    await waitFor(() => expect(jumpToTurn).toHaveBeenCalledWith("t1"))
  })

  // Review finding 6: a jump that did not land re-rendered App every frame for 3 s, then reported success.
  it("tries the jump again when the timeline next lays out, then reports the source found", async () => {
    const { view, jumpToTurn, laidOut } = harness({ turns: [turn("t1")], older: [] })
    jumpToTurn.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    let found: boolean | undefined
    act(() => { void view.result.current(source("t1"), "reply t1").then((value) => { found = value }) })
    await waitFor(() => expect(jumpToTurn).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 100))
    act(() => view.rerender())
    expect(jumpToTurn).toHaveBeenCalledTimes(1)
    laidOut()
    await waitFor(() => expect(jumpToTurn).toHaveBeenCalledTimes(2))
    laidOut()
    await waitFor(() => expect(found).toBe(true))
    expect(jumpToTurn).toHaveBeenCalledTimes(3)
    expect(jumpToTurn).toHaveBeenLastCalledWith("t1")
  })

  it("reports the source not reached when the timeline never lands on it", async () => {
    vi.useFakeTimers()
    try {
      const { view, jumpToTurn, laidOut } = harness({ turns: [turn("t1")], older: [] })
      jumpToTurn.mockResolvedValue(false)
      let found: boolean | undefined
      act(() => { void view.result.current(source("t1"), "reply t1").then((value) => { found = value }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      laidOut()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
      expect(found).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

})
