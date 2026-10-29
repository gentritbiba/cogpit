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
  const jumpToTurn = vi.fn()
  const loadSession = vi.fn()
  const view = renderHook(() => useQuoteNavigation({
    session: session(state.turns),
    sessionSource: state.sessionSource,
    loadSession,
    jumpToTurn,
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
  return { view, state, jumpToTurn, loadSession }
}

describe("useQuoteNavigation", () => {
  it("pages older history in until it finds a quote's turn beyond the loaded tail", async () => {
    const { view, jumpToTurn } = harness({ turns: [turn("t9"), turn("t10")], older: [[turn("t7"), turn("t8")], [turn("t5"), turn("t6")]] })
    let found: boolean | undefined
    act(() => { void view.result.current(source("t5"), "reply t5").then((value) => { found = value }) })
    await waitFor(() => expect(found).toBe(true))
    // t5 is the first of six loaded turns once both pages came in.
    expect(jumpToTurn).toHaveBeenCalledWith(0)
  })

  it("finds a renumbered turn by the quoted text, and reports a deleted source without paging forever", async () => {
    const renumbered = harness({ turns: [turn("new-id", "the exact saved quote and more")], older: [] })
    let found: boolean | undefined
    act(() => { void renumbered.view.result.current(source("old-id"), "the exact saved quote").then((value) => { found = value }) })
    await waitFor(() => expect(found).toBe(true))
    expect(renumbered.jumpToTurn).toHaveBeenCalledWith(0)

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
})
