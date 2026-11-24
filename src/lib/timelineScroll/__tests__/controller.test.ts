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

describe("TimelineScrollController and a hidden pane", () => {
  function mounted() {
    const controller = new TimelineScrollController()
    const scroller = document.createElement("div")
    Object.defineProperty(scroller, "clientHeight", { value: 600 })
    const list = document.createElement("div")
    scroller.append(list)
    document.body.append(scroller)
    controller.setList(list)
    controller.commit({ ...input(vi.fn()), keys: ["a", "b"], hasMore: false })
    controller.setScroller(scroller)
    return { controller, scroller, list }
  }

  it("keeps its rows when its list is hidden, not removed (a machine's pane in the background)", async () => {
    const { controller, scroller } = mounted()
    const plan = controller.getPlan()
    expect(plan.segments.length).toBeGreaterThan(0)

    // A hidden Activity detaches the refs and leaves the list in the document.
    controller.setList(null)
    controller.setScroller(null)
    await Promise.resolve()
    expect(controller.getPlan()).toBe(plan)
    scroller.remove()
  })

  it("lets its rows go when the commit that detached the list removes it", async () => {
    const { controller, scroller } = mounted()
    controller.setList(null)
    scroller.remove()
    await Promise.resolve()
    expect(controller.getPlan().segments).toEqual([])
  })
})
