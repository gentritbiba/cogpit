import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useLiveSession } from "../useLiveSession"
import type { SessionSource } from "../useLiveSession"
import type { ParsedSession } from "@/lib/types"

// Mock parser
vi.mock("@/lib/parser", () => ({
  parseSession: vi.fn(),
  parseSessionAppend: vi.fn(),
}))

// Mock auth
vi.mock("@/lib/auth", () => ({
  authUrl: vi.fn((url: string) => url),
}))

import { parseSession, parseSessionAppend } from "@/lib/parser"

const mockedParseSession = vi.mocked(parseSession)
const mockedParseSessionAppend = vi.mocked(parseSessionAppend)

const mockParsedSession: ParsedSession = {
  sessionId: "s1",
  version: "1",
  gitBranch: "main",
  cwd: "/tmp",
  slug: "test",
  model: "opus",
  turns: [
    {
      id: "t1",
      userMessage: "hi",
      contentBlocks: [],
      thinking: [],
      assistantText: ["hello"],
      toolCalls: [],
      subAgentActivity: [],
      timestamp: "2025-01-15T10:00:00Z",
      durationMs: 100,
      tokenUsage: null,
      model: "opus",
    },
  ],
  stats: {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUSD: 0,
    toolCallCounts: {},
    errorCount: 0,
    totalDurationMs: 0,
    turnCount: 1,
  },
  rawMessages: [],
}

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readyState = 0
  closed = false

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  close() {
    this.closed = true
    this.readyState = 2
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1
    this.onopen?.(new Event("open"))
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }))
  }

  simulateError() {
    this.onerror?.(new Event("error"))
  }
}

describe("useLiveSession", () => {
  const onUpdate = vi.fn()
  let rafCallbacks: Array<() => void> = []

  beforeEach(() => {
    vi.resetAllMocks()
    MockEventSource.instances = []
    rafCallbacks = []
    vi.stubGlobal("EventSource", MockEventSource)
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    mockedParseSession.mockReturnValue(mockParsedSession)
    mockedParseSessionAppend.mockReturnValue(mockParsedSession)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function flushRAF() {
    const cbs = [...rafCallbacks]
    rafCallbacks = []
    cbs.forEach((cb) => cb())
  }

  function getLastEventSource(): MockEventSource {
    return MockEventSource.instances[MockEventSource.instances.length - 1]
  }

  it("returns initial disconnected state with null source", () => {
    const { result } = renderHook(() => useLiveSession(null, onUpdate))
    expect(result.current.isLive).toBe(false)
    expect(result.current.sseState).toBe("disconnected")
  })

  it("does not create EventSource with null source", () => {
    renderHook(() => useLiveSession(null, onUpdate))
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it("creates EventSource when source is provided", () => {
    const source: SessionSource = {
      dirName: "my-project",
      fileName: "session.jsonl",
      rawText: '{"type":"user"}',
    }

    renderHook(() => useLiveSession(source, onUpdate))

    expect(MockEventSource.instances).toHaveLength(1)
    expect(getLastEventSource().url).toBe("/api/watch/my-project/session.jsonl")
  })

  it("sets sseState to connecting initially", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))
    expect(result.current.sseState).toBe("connecting")
  })

  it("sets sseState to connected on open", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))

    act(() => {
      getLastEventSource().simulateOpen()
    })

    expect(result.current.sseState).toBe("connected")
  })

  it("sets sseState to disconnected and isLive to false on error", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))

    act(() => {
      getLastEventSource().simulateOpen()
    })
    expect(result.current.sseState).toBe("connected")

    act(() => {
      getLastEventSource().simulateError()
    })

    expect(result.current.sseState).toBe("disconnected")
    expect(result.current.isLive).toBe(false)
  })

  it("handles init message type", () => {
    vi.useFakeTimers()
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))

    act(() => {
      getLastEventSource().simulateMessage({ type: "init" })
    })

    expect(result.current.sseState).toBe("connected")
    vi.useRealTimers()
  })

  it("sets isLive=true when init has recentlyActive", () => {
    vi.useFakeTimers()
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))

    act(() => {
      getLastEventSource().simulateMessage({ type: "init", recentlyActive: true })
    })

    expect(result.current.isLive).toBe(true)
    expect(result.current.sseState).toBe("connected")
    vi.useRealTimers()
  })

  it("does not set isLive on init without recentlyActive", () => {
    vi.useFakeTimers()
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))

    act(() => {
      getLastEventSource().simulateMessage({ type: "init" })
    })

    expect(result.current.isLive).toBe(false)
    expect(result.current.sseState).toBe("connected")
    vi.useRealTimers()
  })

  it("sets isLive=true and calls onUpdate when lines arrive", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))

    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"assistant","message":{"role":"assistant"}}'],
      })
    })

    expect(result.current.isLive).toBe(true)

    // Flush the rAF callback to trigger onUpdate
    act(() => {
      flushRAF()
    })

    expect(onUpdate).toHaveBeenCalledWith(mockParsedSession)
  })

  it("uses parseSessionAppend when session already exists", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: '{"type":"user"}',
    }

    renderHook(() => useLiveSession(source, onUpdate))

    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"assistant"}'],
      })
    })

    expect(mockedParseSessionAppend).toHaveBeenCalled()
  })

  it("ignores lines messages with empty lines array", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))

    act(() => {
      getLastEventSource().simulateMessage({ type: "lines", lines: [] })
    })

    expect(result.current.isLive).toBe(false)
    act(() => { flushRAF() })
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("closes EventSource on unmount", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { unmount } = renderHook(() => useLiveSession(source, onUpdate))
    const es = getLastEventSource()
    expect(es.closed).toBe(false)

    unmount()
    expect(es.closed).toBe(true)
  })

  it("reconnects when source changes", () => {
    const source1: SessionSource = {
      dirName: "dir1",
      fileName: "a.jsonl",
      rawText: "{}",
    }
    const source2: SessionSource = {
      dirName: "dir2",
      fileName: "b.jsonl",
      rawText: "{}",
    }

    const { rerender } = renderHook(
      (props) => useLiveSession(props.source, onUpdate),
      { initialProps: { source: source1 } }
    )

    expect(MockEventSource.instances).toHaveLength(1)
    const firstES = getLastEventSource()

    rerender({ source: source2 })

    // Old ES should be closed, new one created
    expect(firstES.closed).toBe(true)
    expect(MockEventSource.instances).toHaveLength(2)
    expect(getLastEventSource().url).toBe("/api/watch/dir2/b.jsonl")
  })

  it("encodes dirName and fileName in URL", () => {
    const source: SessionSource = {
      dirName: "dir with spaces",
      fileName: "file name.jsonl",
      rawText: "{}",
    }

    renderHook(() => useLiveSession(source, onUpdate))

    expect(getLastEventSource().url).toBe(
      "/api/watch/dir%20with%20spaces/file%20name.jsonl"
    )
  })

  it("resets isLive when source becomes null", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { result, rerender } = renderHook(
      (props) => useLiveSession(props.source, onUpdate),
      { initialProps: { source: source as SessionSource | null } }
    )

    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"user"}'],
      })
    })

    expect(result.current.isLive).toBe(true)

    rerender({ source: null })

    expect(result.current.isLive).toBe(false)
    expect(result.current.sseState).toBe("disconnected")
  })

  it("coalesces rapid SSE messages into single React update", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    renderHook(() => useLiveSession(source, onUpdate))

    // Send multiple messages rapidly
    act(() => {
      getLastEventSource().simulateMessage({ type: "lines", lines: ['{"a":1}'] })
      getLastEventSource().simulateMessage({ type: "lines", lines: ['{"a":2}'] })
      getLastEventSource().simulateMessage({ type: "lines", lines: ['{"a":3}'] })
    })

    // Before RAF flush, onUpdate shouldn't have been called
    expect(onUpdate).not.toHaveBeenCalled()

    // After RAF flush, should only call once (coalesced)
    act(() => { flushRAF() })
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it("handles malformed SSE data gracefully", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const { result } = renderHook(() => useLiveSession(source, onUpdate))

    // Send invalid JSON via onmessage directly
    act(() => {
      getLastEventSource().onmessage?.(
        new MessageEvent("message", { data: "not-json" })
      )
    })

    // Should not crash, isLive should remain false
    expect(result.current.isLive).toBe(false)
    expect(consoleSpy).toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it("parses initial rawText on mount", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: '{"type":"user","message":{"role":"user","content":"hi"}}',
    }

    renderHook(() => useLiveSession(source, onUpdate))

    expect(mockedParseSession).toHaveBeenCalledWith(source.rawText)
  })

  it("sets isLive=false when rawText is empty", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))
    expect(result.current.isLive).toBe(false)
  })

  it("reconnects when rawText changes (e.g. after undo truncation)", () => {
    const source1: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "original-content",
    }
    const source2: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "truncated-content",
    }

    const { rerender } = renderHook(
      (props) => useLiveSession(props.source, onUpdate),
      { initialProps: { source: source1 } }
    )

    expect(MockEventSource.instances).toHaveLength(1)
    const firstES = getLastEventSource()

    // Same dirName and fileName, but rawText changed
    rerender({ source: source2 })

    // Old ES closed, new one opened
    expect(firstES.closed).toBe(true)
    expect(MockEventSource.instances).toHaveLength(2)
  })

  it("cancels pending rAF on cleanup", () => {
    const mockCancelAnimationFrame = vi.fn()
    vi.stubGlobal("cancelAnimationFrame", mockCancelAnimationFrame)

    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { unmount } = renderHook(() => useLiveSession(source, onUpdate))

    // Send a message to schedule a rAF
    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"user"}'],
      })
    })

    unmount()

    // cancelAnimationFrame should have been called during cleanup
    expect(mockCancelAnimationFrame).toHaveBeenCalled()
  })

  it("uses parseSession (not parseSessionAppend) when sessionRef is null", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "", // empty rawText means sessionRef starts as null
    }

    renderHook(() => useLiveSession(source, onUpdate))

    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"user"}'],
      })
    })

    // Should use parseSession (full parse) since no existing session
    expect(mockedParseSession).toHaveBeenCalled()
  })

  it("uses latest onUpdate callback via ref pattern", () => {
    const onUpdate1 = vi.fn()
    const onUpdate2 = vi.fn()

    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { rerender } = renderHook(
      (props) => useLiveSession(source, props.onUpdate),
      { initialProps: { onUpdate: onUpdate1 } }
    )

    // Switch callback
    rerender({ onUpdate: onUpdate2 })

    // Send message
    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"assistant"}'],
      })
    })

    // Flush rAF
    act(() => { flushRAF() })

    // Should use the new callback
    expect(onUpdate1).not.toHaveBeenCalled()
    expect(onUpdate2).toHaveBeenCalledTimes(1)
  })

  it("sets sseState to connected on receiving any message", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))

    // Before any message, it's connecting
    expect(result.current.sseState).toBe("connecting")

    // An init message should set it to connected
    act(() => {
      getLastEventSource().simulateMessage({ type: "init" })
    })

    expect(result.current.sseState).toBe("connected")
  })

  it("stale timeout sets isLive=false after 30s", () => {
    vi.useFakeTimers()
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate))

    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"user"}'],
      })
    })
    expect(result.current.isLive).toBe(true)

    act(() => {
      vi.advanceTimersByTime(30000)
    })

    expect(result.current.isLive).toBe(false)
    vi.useRealTimers()
  })
})
