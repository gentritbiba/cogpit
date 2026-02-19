import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useNewSession } from "../useNewSession"
import type { PermissionsConfig } from "@/lib/permissions"
import type { ParsedSession } from "@/lib/types"

// Mock authFetch
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

// Mock parseSession
vi.mock("@/lib/parser", () => ({
  parseSession: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { parseSession } from "@/lib/parser"

const mockedAuthFetch = vi.mocked(authFetch)
const mockedParseSession = vi.mocked(parseSession)

const mockParsedSession: ParsedSession = {
  sessionId: "new-session-1",
  version: "1",
  gitBranch: "main",
  cwd: "/tmp",
  slug: "test",
  model: "opus",
  turns: [],
  stats: {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCostUSD: 0,
    toolCallCounts: {},
    errorCount: 0,
    totalDurationMs: 0,
    turnCount: 0,
  },
  rawMessages: [],
}

describe("useNewSession", () => {
  const dispatch = vi.fn()
  const onSessionFinalized = vi.fn()
  const permissionsConfig: PermissionsConfig = { mode: "default" } as PermissionsConfig

  const defaultOpts = {
    permissionsConfig,
    dispatch,
    isMobile: false,
    onSessionFinalized,
    model: "claude-opus-4-6",
  }

  beforeEach(() => {
    vi.resetAllMocks()
    mockedParseSession.mockReturnValue(mockParsedSession)
  })

  it("returns initial state", () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))
    expect(result.current.creatingSession).toBe(false)
    expect(result.current.createError).toBeNull()
    expect(typeof result.current.handleNewSession).toBe("function")
    expect(typeof result.current.createAndSend).toBe("function")
    expect(typeof result.current.clearCreateError).toBe("function")
  })

  it("handleNewSession dispatches INIT_PENDING_SESSION", () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("my-dir")
    })

    expect(dispatch).toHaveBeenCalledWith({
      type: "INIT_PENDING_SESSION",
      dirName: "my-dir",
      isMobile: false,
    })
    expect(result.current.creatingSession).toBe(false)
    expect(result.current.createError).toBeNull()
  })

  it("handleNewSession clears previous error", () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    // First force an error state via a failed createAndSend
    act(() => {
      result.current.handleNewSession("dir1")
    })

    // createError should be null after handleNewSession
    expect(result.current.createError).toBeNull()
  })

  it("createAndSend returns null when no pending dirName", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    let sessionId: string | null = null
    await act(async () => {
      sessionId = await result.current.createAndSend("hello")
    })

    expect(sessionId).toBeNull()
    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })

  it("createAndSend creates session and fetches JSONL on success", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    // Set up the pending dirName
    act(() => {
      result.current.handleNewSession("project-dir")
    })

    // Mock the create-and-send response
    mockedAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          dirName: "project-dir",
          fileName: "session.jsonl",
          sessionId: "session-123",
        }),
      } as Response)
      // Mock the content fetch response
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('{"type":"user","message":{"role":"user","content":"hello"}}'),
      } as Response)

    let sessionId: string | null = null
    await act(async () => {
      sessionId = await result.current.createAndSend("hello")
    })

    expect(sessionId).toBe("session-123")
    expect(result.current.creatingSession).toBe(false)
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "FINALIZE_SESSION" })
    )
    expect(onSessionFinalized).toHaveBeenCalledWith(
      mockParsedSession,
      expect.objectContaining({ dirName: "project-dir", fileName: "session.jsonl" })
    )
  })

  it("createAndSend sets error on failed create response", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    mockedAuthFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Internal server error" }),
    } as Response)

    let sessionId: string | null = null
    await act(async () => {
      sessionId = await result.current.createAndSend("hello")
    })

    expect(sessionId).toBeNull()
    expect(result.current.createError).toBe("Internal server error")
    expect(result.current.creatingSession).toBe(false)
  })

  it("createAndSend handles non-JSON error responses", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    mockedAuthFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error("not json")),
    } as Response)

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    expect(result.current.createError).toBe("Unknown error")
  })

  it("createAndSend sets error when content fetch never returns content", async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useNewSession(defaultOpts))

      act(() => {
        result.current.handleNewSession("dir1")
      })

      let callCount = 0
      mockedAuthFetch.mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          // First call: create-and-send succeeds
          return {
            ok: true,
            json: () => Promise.resolve({
              dirName: "dir1",
              fileName: "s.jsonl",
              sessionId: "sid",
            }),
          } as Response
        }
        // All subsequent calls (polling for JSONL content): return empty text
        return {
          ok: true,
          text: () => Promise.resolve(""),
        } as unknown as Response
      })

      let done = false
      const promise = act(async () => {
        await result.current.createAndSend("hello")
        done = true
      })

      // Fast-forward through all polling delays until the promise resolves
      while (!done) {
        await vi.advanceTimersByTimeAsync(200)
      }
      await promise

      expect(result.current.createError).toBe("Failed to load new session — no content available")
    } finally {
      vi.useRealTimers()
    }
  })

  it("createAndSend handles network errors", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    mockedAuthFetch.mockRejectedValueOnce(new Error("Network failure"))

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    expect(result.current.createError).toBe("Network failure")
    expect(result.current.creatingSession).toBe(false)
  })

  it("createAndSend ignores aborted requests", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    // Simulate abort error
    const abortError = new DOMException("Aborted", "AbortError")
    mockedAuthFetch.mockImplementationOnce((_url, init) => {
      // Simulate the abort controller being triggered
      const signal = (init as RequestInit)?.signal
      if (signal) {
        Object.defineProperty(signal, "aborted", { value: true })
      }
      return Promise.reject(abortError)
    })

    // Start first request
    const promise1 = act(async () => {
      await result.current.createAndSend("first")
    })

    await promise1
    // Aborted request should not set createError (the catch checks signal.aborted)
  })

  it("clearCreateError clears the error", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    mockedAuthFetch.mockRejectedValueOnce(new Error("fail"))

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    expect(result.current.createError).toBe("fail")

    act(() => {
      result.current.clearCreateError()
    })

    expect(result.current.createError).toBeNull()
  })

  it("createAndSend sends images when provided", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    mockedAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dirName: "dir1", fileName: "s.jsonl", sessionId: "sid" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve("{}"),
      } as Response)

    const images = [{ data: "base64data", mediaType: "image/png" }]

    await act(async () => {
      await result.current.createAndSend("describe this", images)
    })

    const body = JSON.parse((mockedAuthFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.images).toEqual(images)
    expect(body.message).toBe("describe this")
    expect(body.dirName).toBe("dir1")
  })

  it("passes isMobile=true correctly", () => {
    const { result } = renderHook(() =>
      useNewSession({ ...defaultOpts, isMobile: true })
    )

    act(() => {
      result.current.handleNewSession("dir1")
    })

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ isMobile: true })
    )
  })
})
