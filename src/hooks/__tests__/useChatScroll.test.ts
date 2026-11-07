import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useChatScroll } from "../useChatScroll"
import { type SessionView, EMPTY_SESSION_DIGEST } from "../../../shared/session/sessionDigest"

// Minimal parsed session factory
function makeSession(turnCount: number): SessionView {
  return {
    sessionId: "s1",
    version: "1",
    gitBranch: "main",
    cwd: "/tmp",
    slug: "test",
    name: "",
    model: "opus",
    turns: Array.from({ length: turnCount }, (_, i) => ({
      id: `t${i}`,
      userMessage: `msg ${i}`,
      contentBlocks: [],
      thinking: [],
      assistantText: [`resp ${i}`],
      toolCalls: [],
      subAgentActivity: [],
      timestamp: "2025-01-15T10:00:00Z",
      durationMs: 100,
      tokenUsage: null,
      model: "opus",
    })),
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount,
    },
    digest: EMPTY_SESSION_DIGEST,
  }
}

describe("useChatScroll", () => {
  const consumePending = vi.fn()
  let rafCallbacks: Array<() => void> = []

  beforeEach(() => {
    vi.clearAllMocks()
    rafCallbacks = []
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const defaultOpts = {
    session: null as SessionView | null,
    isLive: false,
    pendingMessages: [] as string[],
    consumePending,
    sessionChangeKey: 0,
  }

  it("returns refs and state", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))
    expect(result.current.chatScrollRef).toBeDefined()
    expect(result.current.canScrollDown).toBe(false)
    expect(typeof result.current.handleScroll).toBe("function")
    expect(typeof result.current.scrollToBottomInstant).toBe("function")
    expect(typeof result.current.resetTurnCount).toBe("function")
  })

  it("initializes canScrollDown as false", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))
    expect(result.current.canScrollDown).toBe(false)
  })

  it("scrollToBottomInstant sets scrollTop on the ref element", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))

    // Create a mock div element
    const mockEl = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 500,
    }
    // @ts-expect-error - assigning mock to ref
    result.current.chatScrollRef.current = mockEl

    act(() => {
      result.current.scrollToBottomInstant()
    })

    expect(mockEl.scrollTop).toBe(1000)
  })

  it("handleScroll updates scroll indicators based on element position", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))

    const mockEl = {
      scrollTop: 100,
      scrollHeight: 1000,
      clientHeight: 400,
    }
    // @ts-expect-error - assigning mock to ref
    result.current.chatScrollRef.current = mockEl

    act(() => {
      result.current.handleScroll()
    })

    // scrollHeight(1000) - scrollTop(100) - clientHeight(400) = 500 > 10 => canScrollDown = true
    expect(result.current.canScrollDown).toBe(true)
  })

  it("handleScroll sets canScrollDown=false when near bottom", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))

    const mockEl = {
      scrollTop: 595, // 1000 - 595 - 400 = 5 < 10
      scrollHeight: 1000,
      clientHeight: 400,
    }
    // @ts-expect-error - assigning mock to ref
    result.current.chatScrollRef.current = mockEl

    act(() => {
      result.current.handleScroll()
    })

    expect(result.current.canScrollDown).toBe(false)
  })

  it("handleScroll does nothing when chatScrollRef is null", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))
    // ref is null by default
    act(() => {
      result.current.handleScroll()
    })
    // No error thrown, states unchanged
    expect(result.current.canScrollDown).toBe(false)
  })

  it("resetTurnCount updates the internal counter", () => {
    const session = makeSession(3)
    const { result, rerender } = renderHook(
      (props) => useChatScroll(props),
      { initialProps: { ...defaultOpts, session } }
    )

    // Reset the internal counter so new turns aren't treated as "new"
    act(() => {
      result.current.resetTurnCount(3)
    })

    // Now rerender with same session - should not trigger consumePending
    rerender({ ...defaultOpts, session })
    expect(consumePending).not.toHaveBeenCalled()
  })

  it("consumes pending messages when new turns arrive", () => {
    const session1 = makeSession(1)
    const session2 = makeSession(2)

    const { rerender } = renderHook(
      (props) => useChatScroll(props),
      {
        initialProps: {
          ...defaultOpts,
          session: session1,
          pendingMessages: ["waiting..."],
        },
      }
    )

    // Add a turn
    rerender({
      ...defaultOpts,
      session: session2,
      pendingMessages: ["waiting..."],
    })

    expect(consumePending).toHaveBeenCalledWith(1)
  })

  it("replaces an optimistic preview when a queued Claude prompt is persisted", () => {
    const initial = makeSession(1)
    const { rerender } = renderHook(
      (props) => useChatScroll(props),
      { initialProps: { ...defaultOpts, session: initial } },
    )

    rerender({
      ...defaultOpts,
      session: initial,
      pendingMessages: ["Also check the tests"],
    })
    expect(consumePending).not.toHaveBeenCalled()

    const persisted = makeSession(1)
    persisted.turns[0].contentBlocks.push({
      kind: "queued_prompt",
      content: "Also check the tests",
      timestamp: "2025-01-15T10:00:01Z",
    })
    rerender({
      ...defaultOpts,
      session: persisted,
      pendingMessages: ["Also check the tests"],
    })

    expect(consumePending).toHaveBeenCalledWith(1)
  })

  it("does not consume a new preview because of historical queued prompts", () => {
    const session = makeSession(1)
    session.turns[0].contentBlocks.push({
      kind: "queued_prompt",
      content: "An older prompt",
      timestamp: "2025-01-15T10:00:01Z",
    })
    const { rerender } = renderHook(
      (props) => useChatScroll(props),
      { initialProps: { ...defaultOpts, session } },
    )

    rerender({
      ...defaultOpts,
      session,
      pendingMessages: ["A new prompt"],
    })

    expect(consumePending).not.toHaveBeenCalled()
  })

  it("does not consume a preview when a different queued prompt arrives externally", () => {
    const initial = makeSession(1)
    const { rerender } = renderHook(
      (props) => useChatScroll(props),
      { initialProps: { ...defaultOpts, session: initial } },
    )

    rerender({
      ...defaultOpts,
      session: initial,
      pendingMessages: ["Dashboard prompt"],
    })

    const updated = makeSession(1)
    updated.turns[0].contentBlocks.push({
      kind: "queued_prompt",
      content: "Prompt sent from another client",
      timestamp: "2025-01-15T10:00:01Z",
    })
    rerender({
      ...defaultOpts,
      session: updated,
      pendingMessages: ["Dashboard prompt"],
    })

    expect(consumePending).not.toHaveBeenCalled()
  })

  it("does not update scroll indicators when values haven't changed", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))

    const mockEl = {
      scrollTop: 5,
      scrollHeight: 500,
      clientHeight: 490, // scrollHeight - scrollTop - clientHeight = 5 < 10
    }
    // @ts-expect-error - assigning mock to ref
    result.current.chatScrollRef.current = mockEl

    // First call sets canScrollDown=false
    act(() => { result.current.handleScroll() })
    expect(result.current.canScrollDown).toBe(false)

    // Second call with same values - should not trigger extra rerenders
    act(() => { result.current.handleScroll() })
    expect(result.current.canScrollDown).toBe(false)
  })

  it.each([true, false])("handles padding-only footer growth with bottom anchoring %s", (atBottom) => {
    let resized!: ResizeObserverCallback
    const observe = vi.fn(); const disconnect = vi.fn()
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resized = callback }
      observe = observe
      disconnect = disconnect
    })
    const { result } = renderHook(() => useChatScroll({ ...defaultOpts, session: makeSession(1), isLive: false }))
    const viewport = { scrollTop: atBottom ? 500 : 100, scrollHeight: 1000, clientHeight: 500, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    result.current.chatScrollRef.current = viewport as unknown as HTMLDivElement
    const content = document.createElement("div")
    act(() => { result.current.observeChatContent(content); result.current.handleScroll() })
    expect(observe).toHaveBeenCalledWith(content, { box: "border-box" })
    content.style.paddingBottom = "300px"
    viewport.scrollHeight = 1200
    act(() => {
      result.current.handleScroll()
      resized([{ target: content, contentRect: { height: 700 }, borderBoxSize: [{ blockSize: 1200 }] }] as unknown as ResizeObserverEntry[], {} as ResizeObserver)
      for (const callback of rafCallbacks.splice(0)) callback()
    })
    expect(viewport.scrollTop).toBe(atBottom ? 1200 : 100)
    expect(result.current.canScrollDown).toBe(!atBottom)
    act(() => result.current.observeChatContent(null))
    expect(disconnect).toHaveBeenCalledOnce()
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it("reports initialScrollDone only after the session-change placement settles", () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook(
        (props) => useChatScroll(props),
        { initialProps: { ...defaultOpts, session: makeSession(2) } },
      )
      // No placement has happened for the initial key.
      expect(result.current.initialScrollDone).toBe(false)

      rerender({ ...defaultOpts, session: makeSession(2), sessionChangeKey: 1 })
      expect(result.current.initialScrollDone).toBe(false)

      act(() => { vi.advanceTimersByTime(150) })
      expect(result.current.initialScrollDone).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("resets initialScrollDone immediately when another session loads", () => {
    vi.useFakeTimers()
    try {
      const { result, rerender } = renderHook(
        (props) => useChatScroll(props),
        { initialProps: { ...defaultOpts, session: makeSession(2), sessionChangeKey: 1 } },
      )
      act(() => { vi.advanceTimersByTime(150) })
      expect(result.current.initialScrollDone).toBe(false)

      rerender({ ...defaultOpts, session: makeSession(2), sessionChangeKey: 2 })
      expect(result.current.initialScrollDone).toBe(false)

      act(() => { vi.advanceTimersByTime(150) })
      expect(result.current.initialScrollDone).toBe(true)

      // A new load invalidates the gate at render time, before any effects.
      rerender({ ...defaultOpts, session: makeSession(3), sessionChangeKey: 3 })
      expect(result.current.initialScrollDone).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
  it.each(["wheel", "keyboard", "touch", "scrollbar"])("lets %s movement escape the bottom before content resizes", (kind) => {
    let resized!: ResizeObserverCallback
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resized = callback }
      observe() {} disconnect() {}
    })
    const { result } = renderHook(() => useChatScroll({ ...defaultOpts, session: makeSession(1), isLive: true }))
    const viewport = document.createElement("div")
    Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { value: 500 } })
    viewport.scrollTop = 500
    result.current.chatScrollRef.current = viewport
    act(() => { result.current.observeChatContent(document.createElement("div")); result.current.handleScroll() })
    act(() => {
      if (kind === "wheel") viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -5 }))
      if (kind === "keyboard") viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }))
      if (kind === "touch") {
        viewport.dispatchEvent(new TouchEvent("touchstart", { touches: [{ clientY: 100 }] as Touch[] }))
        viewport.dispatchEvent(new TouchEvent("touchmove", { touches: [{ clientY: 105 }] as Touch[] }))
      }
      viewport.scrollTop = 495
      result.current.handleScroll()
      Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1100 })
      resized([], {} as ResizeObserver)
      for (const callback of rafCallbacks.splice(0)) callback()
    })
    expect(viewport.scrollTop).toBe(495)
    act(() => result.current.scrollToBottomInstant())
    expect(viewport.scrollTop).toBe(1100)
    act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -5 }))
      viewport.scrollTop = 590
      for (const callback of rafCallbacks.splice(0)) callback()
    })
    expect(viewport.scrollTop).toBe(590)
  })

  it("does not resume following when a content collapse clamps an upward scroll to the bottom", () => {
    let resized!: ResizeObserverCallback
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resized = callback }
      observe() {} disconnect() {}
    })
    const { result } = renderHook(() => useChatScroll(defaultOpts))
    const viewport = document.createElement("div")
    let height = 1000
    Object.defineProperties(viewport, { scrollHeight: { get: () => height }, clientHeight: { value: 500 } })
    viewport.scrollTop = 500
    result.current.chatScrollRef.current = viewport
    act(() => { result.current.observeChatContent(document.createElement("div")); result.current.handleScroll() })
    act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -25 }))
      viewport.scrollTop = 475
      result.current.handleScroll()
      height = 900
      viewport.scrollTop = 400
      result.current.handleScroll()
      height = 1200
      resized([], {} as ResizeObserver)
      for (const callback of rafCallbacks.splice(0)) callback()
    })
    expect(viewport.scrollTop).toBe(400)
    act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 300 }))
      viewport.scrollTop = 700
      result.current.handleScroll()
      height = 1300
      resized([], {} as ResizeObserver)
      for (const callback of rafCallbacks.splice(0)) callback()
    })
    expect(viewport.scrollTop).toBe(1300)
  })

})
