import { describe, expect, it, vi } from "vitest"
import { TimelineScrollController, type TimelineRowsInput } from "../controller"

const input = (onLoadMore: () => void): TimelineRowsInput => ({
  keys: [],
  sessionKey: "a",
  sessionChangeKey: 1,
  expandAll: false,
  hasMore: true,
  isLoadingOlder: false,
  onLoadMore,
})

describe("TimelineScrollController paging", () => {
  it("never pages the previous session once its list has unmounted", () => {
    const controller = new TimelineScrollController()
    const scroller = document.createElement("div")
    Object.defineProperty(scroller, "clientHeight", { value: 600 })
    const onLoadMore = vi.fn()
    controller.setList(document.createElement("div"))
    controller.commit(input(onLoadMore))
    controller.setScroller(scroller)
    expect(onLoadMore).toHaveBeenCalled()
    onLoadMore.mockClear()

    // A session with no turns shows no list, so the last commit's input is stale.
    controller.setList(null)
    controller.setScroller(null)
    controller.setScroller(scroller)
    expect(onLoadMore).not.toHaveBeenCalled()
  })
})
