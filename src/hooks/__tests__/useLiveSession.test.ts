import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useLiveSession } from "../useLiveSession"
import type { SessionSource } from "../useLiveSession"
import type { ParsedSession } from "@/lib/types"

// Mock auth
vi.mock("@/lib/auth", () => ({
  authUrl: vi.fn((url: string) => url),
}))

// Mock sessionCache
vi.mock("@/lib/sessionCache", () => ({
  sessionCache: {
    get: vi.fn(() => undefined),
    set: vi.fn(),
    update: vi.fn(),
    updateRawText: vi.fn(),
    evict: vi.fn(),
    clear: vi.fn(),
  },
}))

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
  let workerParse: ReturnType<typeof vi.fn>
  let workerAppend: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetAllMocks()
    MockEventSource.instances = []
    rafCallbacks = []
    workerParse = vi.fn(() => Promise.resolve(mockParsedSession))
    workerAppend = vi.fn(() => Promise.resolve(mockParsedSession))
    vi.stubGlobal("EventSource", MockEventSource)
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
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
    const { result } = renderHook(() => useLiveSession(null, onUpdate, workerParse, workerAppend))
    expect(result.current.isLive).toBe(false)
    expect(result.current.sseState).toBe("disconnected")
  })

  it("does not create EventSource with null source", () => {
    renderHook(() => useLiveSession(null, onUpdate, workerParse, workerAppend))
    expect(MockEventSource.instances).toHaveLength(0)
  })

  it("creates EventSource when source is provided", () => {
    const source: SessionSource = {
      dirName: "my-project",
      fileName: "session.jsonl",
      rawText: '{"type":"user"}',
    }

    renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    expect(MockEventSource.instances).toHaveLength(1)
    expect(getLastEventSource().url).toBe("/api/watch/my-project/session.jsonl")
  })

  it("sets sseState to connecting initially", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))
    expect(result.current.sseState).toBe("connecting")
  })

  it("sets sseState to connected on open", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

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

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

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

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

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

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

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

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    act(() => {
      getLastEventSource().simulateMessage({ type: "init" })
    })

    expect(result.current.isLive).toBe(false)
    expect(result.current.sseState).toBe("connected")
    vi.useRealTimers()
  })

  it("sets isLive=true and calls onUpdate when lines arrive", async () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"assistant","message":{"role":"assistant"}}'],
      })
    })

    expect(result.current.isLive).toBe(true)

    // Wait for the async worker parse to resolve
    await act(async () => {
      await Promise.resolve()
    })

    // Flush the rAF callback to trigger onUpdate
    act(() => {
      flushRAF()
    })

    expect(onUpdate).toHaveBeenCalledWith(mockParsedSession)
  })

  it("uses workerAppend when session already exists", async () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: '{"type":"user"}',
    }

    renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    // Wait for initial workerParse to resolve (rawText effect)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"assistant"}'],
      })
    })

    // Wait for the chained parse promise to resolve
    // (chain: previous resolve -> workerAppend -> then)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(workerAppend).toHaveBeenCalled()
  })

  it("ignores lines messages with empty lines array", async () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    act(() => {
      getLastEventSource().simulateMessage({ type: "lines", lines: [] })
    })

    expect(result.current.isLive).toBe(false)
    await act(async () => { await Promise.resolve() })
    act(() => { flushRAF() })
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("closes EventSource on unmount", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "file.jsonl",
      rawText: "{}",
    }

    const { unmount } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))
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
      (props) => useLiveSession(props.source, onUpdate, workerParse, workerAppend),
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

    renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    expect(getLastEventSource().url).toBe(
      "/api/watch/dir%20with%20spaces/file%20name.jsonl"
    )
  })

  it("resets isLive when source becomes null", async () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { result, rerender } = renderHook(
      (props) => useLiveSession(props.source, onUpdate, workerParse, workerAppend),
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

  it("coalesces rapid SSE messages into ≤ 2 worker calls (burst compression)", async () => {
    // Regression guard for the bash-output lag: without burst compression the
    // hook used to chain one workerAppend per SSE message, which scaled with
    // structured-clone cost of the whole ParsedSession per message. The
    // current design flushes to the worker only when it's idle, so N rapid
    // arrivals collapse to at most ~2 worker calls (one in-flight, one
    // drain pass).
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    // Provide an initialSession so the mount-time parse is skipped — this
    // isolates the burst test to only count appends triggered by SSE.
    renderHook(() =>
      useLiveSession(source, onUpdate, workerParse, workerAppend, undefined, mockParsedSession)
    )

    // Fire a burst of 20 SSE messages synchronously; the worker promise from
    // the first flush is still pending when messages 2–20 arrive.
    act(() => {
      for (let i = 0; i < 20; i++) {
        getLastEventSource().simulateMessage({
          type: "lines",
          lines: [`{"type":"assistant","i":${i}}`],
        })
      }
    })

    // Let the worker microtasks drain — a few turns of the microtask queue
    // is enough because the second flush runs in the .finally of the first.
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })

    // One call kicked off on arrival of message #0, one drain pass picks up
    // the batched remainder (messages 1–19). More than two would mean the
    // burst compression regressed back to per-message parse chains.
    expect(workerAppend.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(workerAppend.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it("coalesces rapid SSE messages into single React update", async () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    // Send multiple messages rapidly
    act(() => {
      getLastEventSource().simulateMessage({ type: "lines", lines: ['{"a":1}'] })
      getLastEventSource().simulateMessage({ type: "lines", lines: ['{"a":2}'] })
      getLastEventSource().simulateMessage({ type: "lines", lines: ['{"a":3}'] })
    })

    // Wait for async parses to resolve
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

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

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

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

  it("calls workerParse with initial rawText on mount when no initialSession provided", async () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: '{"type":"user","message":{"role":"user","content":"hi"}}',
    }

    renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    await act(async () => { await Promise.resolve() })

    expect(workerParse).toHaveBeenCalledWith(source.rawText)
  })

  it("skips the mount-time worker parse when initialSession is provided (fast path)", async () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: '{"type":"user","message":{"role":"user","content":"hi"}}',
    }

    renderHook(() =>
      useLiveSession(source, onUpdate, workerParse, workerAppend, undefined, mockParsedSession)
    )

    await act(async () => { await Promise.resolve() })

    // When the caller already provides the parsed session, no re-parse happens.
    expect(workerParse).not.toHaveBeenCalled()
  })

  it("uses the provided initialSession as the base for SSE append (no mount parse)", async () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: '{"type":"user"}',
    }

    renderHook(() =>
      useLiveSession(source, onUpdate, workerParse, workerAppend, undefined, mockParsedSession)
    )

    // No initial parse work.
    await act(async () => { await Promise.resolve() })
    expect(workerParse).not.toHaveBeenCalled()

    // SSE line arrives — should go through workerAppend using mockParsedSession as base.
    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"assistant"}'],
      })
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(workerAppend).toHaveBeenCalledWith(mockParsedSession, expect.any(String))
    expect(workerParse).not.toHaveBeenCalled()
  })

  it("sets isLive=false when rawText is empty", () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))
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
      (props) => useLiveSession(props.source, onUpdate, workerParse, workerAppend),
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

  it("cancels pending rAF on cleanup", async () => {
    const mockCancelAnimationFrame = vi.fn()
    vi.stubGlobal("cancelAnimationFrame", mockCancelAnimationFrame)

    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { unmount } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    // Send a message to schedule a rAF
    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"user"}'],
      })
    })

    // Wait for async parse to schedule the RAF
    await act(async () => { await Promise.resolve() })

    unmount()

    // cancelAnimationFrame should have been called during cleanup
    expect(mockCancelAnimationFrame).toHaveBeenCalled()
  })

  it("uses workerParse (not workerAppend) when sessionRef is null", async () => {
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "", // empty rawText means sessionRef starts as null
    }

    renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    act(() => {
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"user"}'],
      })
    })

    await act(async () => { await Promise.resolve() })

    // Should use workerParse (full parse) since no existing session
    expect(workerParse).toHaveBeenCalled()
    expect(workerAppend).not.toHaveBeenCalled()
  })

  it("uses latest onUpdate callback via ref pattern", async () => {
    const onUpdate1 = vi.fn()
    const onUpdate2 = vi.fn()

    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { rerender } = renderHook(
      (props) => useLiveSession(source, props.onUpdate, workerParse, workerAppend),
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

    // Wait for async parse
    await act(async () => { await Promise.resolve() })

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

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    // Before any message, it's connecting
    expect(result.current.sseState).toBe("connecting")

    // An init message should set it to connected
    act(() => {
      getLastEventSource().simulateMessage({ type: "init" })
    })

    expect(result.current.sseState).toBe("connected")
  })

  it("stale timeout sets isLive=false after 30s", async () => {
    vi.useFakeTimers()
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

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

  it("recentlyActive uses 5s confirmation timer — goes false if no lines arrive", () => {
    vi.useFakeTimers()
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    act(() => {
      getLastEventSource().simulateMessage({ type: "init", recentlyActive: true })
    })
    expect(result.current.isLive).toBe(true)

    // After 5s with no lines, isLive should go false
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.isLive).toBe(false)

    vi.useRealTimers()
  })

  describe("stream_event SSE handling", () => {
    it("exposes partialMessages that grow with stream_event deltas", async () => {
      const source: SessionSource = {
        dirName: "dir",
        fileName: "f.jsonl",
        rawText: "{}",
      }

      const { result } = renderHook(() =>
        useLiveSession(source, onUpdate, workerParse, workerAppend)
      )

      // Fire message_start + content_block_start + text_delta
      act(() => {
        getLastEventSource().simulateMessage({
          type: "stream_event",
          event: { type: "message_start", message: { id: "msg_live_1" } },
          parent_tool_use_id: null,
        })
      })
      act(() => {
        getLastEventSource().simulateMessage({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text" },
          },
          parent_tool_use_id: null,
        })
      })
      act(() => {
        getLastEventSource().simulateMessage({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hel" },
          },
          parent_tool_use_id: null,
        })
      })
      act(() => {
        getLastEventSource().simulateMessage({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "lo" },
          },
          parent_tool_use_id: null,
        })
      })

      // Flush the rAF coalescer so setPartialMessages commits.
      act(() => {
        flushRAF()
      })

      const partials = result.current.partialMessages
      expect(partials.has("msg_live_1")).toBe(true)
      const partial = partials.get("msg_live_1")!
      expect(partial.blocks.get(0)).toEqual({ type: "text", text: "Hello" })
    })

    it("discards partial for message.id when canonical assistant line arrives", async () => {
      const canonicalWithAssistant: ParsedSession = {
        ...mockParsedSession,
        rawMessages: [
          {
            type: "assistant",
            message: { id: "msg_live_1", role: "assistant", content: [] },
          },
        ],
      }
      // After the burst arrives, the worker resolves with the canonical session
      // containing the just-streamed assistant id — reconciliation must drop it.
      workerAppend = vi.fn(() => Promise.resolve(canonicalWithAssistant))
      workerParse = vi.fn(() => Promise.resolve(canonicalWithAssistant))

      const source: SessionSource = {
        dirName: "dir",
        fileName: "f.jsonl",
        rawText: "{}",
      }

      const { result } = renderHook(() =>
        useLiveSession(source, onUpdate, workerParse, workerAppend)
      )

      // Seed a partial via stream_event.
      act(() => {
        getLastEventSource().simulateMessage({
          type: "stream_event",
          event: { type: "message_start", message: { id: "msg_live_1" } },
          parent_tool_use_id: null,
        })
      })
      act(() => {
        flushRAF()
      })
      expect(result.current.partialMessages.has("msg_live_1")).toBe(true)

      // Canonical JSONL line arrives → worker returns a session whose
      // rawMessages contains the assistant with matching id → partial dropped.
      act(() => {
        getLastEventSource().simulateMessage({
          type: "lines",
          lines: ['{"type":"assistant","message":{"id":"msg_live_1"}}'],
        })
      })
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      act(() => {
        flushRAF()
      })

      expect(result.current.partialMessages.has("msg_live_1")).toBe(false)
    })

    it("resets partialMessages when source changes", () => {
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

      const { result, rerender } = renderHook(
        (props) => useLiveSession(props.source, onUpdate, workerParse, workerAppend),
        { initialProps: { source: source1 } }
      )

      // Seed a partial on source1.
      act(() => {
        getLastEventSource().simulateMessage({
          type: "stream_event",
          event: { type: "message_start", message: { id: "msg_a" } },
          parent_tool_use_id: null,
        })
      })
      act(() => {
        flushRAF()
      })
      expect(result.current.partialMessages.has("msg_a")).toBe(true)

      // Switch source — partials must be cleared.
      rerender({ source: source2 })

      expect(result.current.partialMessages.size).toBe(0)
    })

    it("commits partial drop and canonical update atomically (no flicker at reconciliation)", async () => {
      // Reconciliation flicker repro: if `setPartialMessages(drop)` commits
      // urgently while `onUpdate(canonical)` is transition-deferred, React 18
      // splits the commits and the UI renders an empty frame between them.
      // The hook must flush both state changes in the same commit so the
      // observable (hasPartial, canonicalUpdated) never transitions through
      // (false, false).
      const canonicalWithAssistant: ParsedSession = {
        ...mockParsedSession,
        rawMessages: [
          {
            type: "assistant",
            message: { id: "msg_atomic", role: "assistant", content: [] },
          },
        ],
      }
      workerAppend = vi.fn(() => Promise.resolve(canonicalWithAssistant))
      workerParse = vi.fn(() => Promise.resolve(canonicalWithAssistant))

      const source: SessionSource = {
        dirName: "dir",
        fileName: "f.jsonl",
        rawText: "{}",
      }

      const onUpdateLocal = vi.fn()
      const { result } = renderHook(() =>
        useLiveSession(source, onUpdateLocal, workerParse, workerAppend)
      )

      // Seed a partial and commit it.
      act(() => {
        getLastEventSource().simulateMessage({
          type: "stream_event",
          event: { type: "message_start", message: { id: "msg_atomic" } },
          parent_tool_use_id: null,
        })
      })
      act(() => { flushRAF() })
      expect(result.current.partialMessages.has("msg_atomic")).toBe(true)
      expect(onUpdateLocal).not.toHaveBeenCalled()

      // Canonical JSONL line arrives. Worker resolves with a session whose
      // rawMessages already contains the assistant id — reconciliation runs
      // and both the partial-drop and the session-update land on the same
      // rAF flush.
      act(() => {
        getLastEventSource().simulateMessage({
          type: "lines",
          lines: ['{"type":"assistant","message":{"id":"msg_atomic"}}'],
        })
      })
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      act(() => { flushRAF() })

      // Both outcomes must be observable post-flush: the partial is dropped
      // AND the canonical session has been dispatched. If these commits were
      // split across ticks (the flicker bug), one of these would be false
      // during the interstitial render.
      expect(result.current.partialMessages.has("msg_atomic")).toBe(false)
      expect(onUpdateLocal).toHaveBeenCalledWith(canonicalWithAssistant)
    })

    it("resets partialMessages on SSE disconnect (so reconnect starts clean)", () => {
      const source: SessionSource = {
        dirName: "dir",
        fileName: "f.jsonl",
        rawText: "{}",
      }

      const { result } = renderHook(() =>
        useLiveSession(source, onUpdate, workerParse, workerAppend)
      )

      // Connect + seed a partial.
      act(() => {
        getLastEventSource().simulateOpen()
      })
      act(() => {
        getLastEventSource().simulateMessage({
          type: "stream_event",
          event: { type: "message_start", message: { id: "msg_b" } },
          parent_tool_use_id: null,
        })
      })
      act(() => {
        flushRAF()
      })
      expect(result.current.partialMessages.has("msg_b")).toBe(true)

      // Disconnect — partials must be dropped so a reconnect doesn't replay
      // stale in-flight deltas that were never completed.
      act(() => {
        getLastEventSource().simulateError()
      })

      expect(result.current.partialMessages.size).toBe(0)
    })
  })

  it("recentlyActive confirmation timer is replaced by 30s timer when lines arrive", () => {
    vi.useFakeTimers()
    const source: SessionSource = {
      dirName: "dir",
      fileName: "f.jsonl",
      rawText: "{}",
    }

    const { result } = renderHook(() => useLiveSession(source, onUpdate, workerParse, workerAppend))

    act(() => {
      getLastEventSource().simulateMessage({ type: "init", recentlyActive: true })
    })
    expect(result.current.isLive).toBe(true)

    // Lines arrive within 5s — confirms session is alive, resets to 30s timer
    act(() => {
      vi.advanceTimersByTime(2000)
      getLastEventSource().simulateMessage({
        type: "lines",
        lines: ['{"type":"user"}'],
      })
    })
    expect(result.current.isLive).toBe(true)

    // After another 5s (7s total), still live because lines reset to 30s timer
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(result.current.isLive).toBe(true)

    // After 30s from the lines message, goes false
    act(() => {
      vi.advanceTimersByTime(25000)
    })
    expect(result.current.isLive).toBe(false)

    vi.useRealTimers()
  })
})
