import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useTimelineScroll } from "../useTimelineScroll"

const defaults = {
  session: null,
  pendingMessages: [] as string[],
  consumePending: vi.fn(),
  historyBytes: { remaining: 0, loaded: 0 },
}

describe("useTimelineScroll", () => {
  it("exposes one controller for the shell's lifetime", () => {
    const { result, rerender } = renderHook((props) => useTimelineScroll(props), { initialProps: defaults })
    const controller = result.current.controller
    rerender({ ...defaults, historyBytes: { remaining: 10, loaded: 20 } })
    expect(result.current.controller).toBe(controller)
    expect(result.current.chatScrollRef).toBe(controller.scrollerRef)
    expect(result.current.canScrollDown).toBe(false)
  })

  it("returns to the bottom when the reader sends a message", () => {
    const { result, rerender } = renderHook((props) => useTimelineScroll(props), { initialProps: defaults })
    const scrollToBottom = vi.spyOn(result.current.controller, "scrollToBottom")
    rerender({ ...defaults, pendingMessages: ["hello"] })
    expect(scrollToBottom).toHaveBeenCalledOnce()
    rerender({ ...defaults, pendingMessages: [] })
    expect(scrollToBottom).toHaveBeenCalledOnce()
  })

  it("asks the next session to open at its top", () => {
    const { result } = renderHook(() => useTimelineScroll(defaults))
    const request = vi.spyOn(result.current.controller, "requestTopOnNextSession")
    result.current.requestScrollToTop()
    expect(request).toHaveBeenCalledOnce()
  })
})
