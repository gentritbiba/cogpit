import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useChatScroll } from "../useChatScroll"
import type { ParsedSession } from "@/lib/types"

// Minimal parsed session factory
function makeSession(turnCount: number): ParsedSession {
  return {
    sessionId: "s1",
    version: "1",
    gitBranch: "main",
    cwd: "/tmp",
    slug: "test",
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
      totalCostUSD: 0,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 0,
      turnCount,
    },
    rawMessages: [],
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
    session: null as ParsedSession | null,
    isLive: false,
    pendingMessages: [] as string[],
    consumePending,
    sessionChangeKey: 0,
  }

  it("returns refs and state", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))
    expect(result.current.chatScrollRef).toBeDefined()
    expect(result.current.scrollEndRef).toBeDefined()
    expect(result.current.canScrollUp).toBe(false)
    expect(result.current.canScrollDown).toBe(false)
    expect(typeof result.current.handleScroll).toBe("function")
    expect(typeof result.current.scrollToBottomInstant).toBe("function")
    expect(typeof result.current.resetTurnCount).toBe("function")
  })

  it("initializes canScrollUp and canScrollDown as false", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))
    expect(result.current.canScrollUp).toBe(false)
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

    // scrollTop > 10 => canScrollUp = true
    expect(result.current.canScrollUp).toBe(true)
    // scrollHeight(1000) - scrollTop(100) - clientHeight(400) = 500 > 10 => canScrollDown = true
    expect(result.current.canScrollDown).toBe(true)
  })

  it("handleScroll sets canScrollUp=false when near top", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))

    const mockEl = {
      scrollTop: 5, // < 10
      scrollHeight: 1000,
      clientHeight: 400,
    }
    // @ts-expect-error - assigning mock to ref
    result.current.chatScrollRef.current = mockEl

    act(() => {
      result.current.handleScroll()
    })

    expect(result.current.canScrollUp).toBe(false)
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

    expect(result.current.canScrollUp).toBe(true)
    expect(result.current.canScrollDown).toBe(false)
  })

  it("handleScroll does nothing when chatScrollRef is null", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))
    // ref is null by default
    act(() => {
      result.current.handleScroll()
    })
    // No error thrown, states unchanged
    expect(result.current.canScrollUp).toBe(false)
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

  it("does not update scroll indicators when values haven't changed", () => {
    const { result } = renderHook(() => useChatScroll(defaultOpts))

    const mockEl = {
      scrollTop: 5,
      scrollHeight: 500,
      clientHeight: 490, // scrollHeight - scrollTop - clientHeight = 5 < 10
    }
    // @ts-expect-error - assigning mock to ref
    result.current.chatScrollRef.current = mockEl

    // First call sets canScrollUp=false, canScrollDown=false
    act(() => { result.current.handleScroll() })
    expect(result.current.canScrollUp).toBe(false)
    expect(result.current.canScrollDown).toBe(false)

    // Second call with same values - should not trigger extra rerenders
    act(() => { result.current.handleScroll() })
    expect(result.current.canScrollUp).toBe(false)
    expect(result.current.canScrollDown).toBe(false)
  })
})
