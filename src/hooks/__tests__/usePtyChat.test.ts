import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { usePtyChat } from "../usePtyChat"

const mockedAuthFetch = vi.mocked(authFetch)

describe("usePtyChat", () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it("starts with idle status", () => {
    const { result } = renderHook(() =>
      usePtyChat({ sessionSource: null })
    )
    expect(result.current.status).toBe("idle")
    expect(result.current.error).toBeUndefined()
    expect(result.current.pendingMessage).toBeNull()
    expect(result.current.isConnected).toBe(false)
  })

  it("does nothing when sendMessage called with no sessionId and no onCreateSession", async () => {
    const { result } = renderHook(() =>
      usePtyChat({ sessionSource: null })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    expect(result.current.status).toBe("idle")
    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })

  it("sends message and transitions through connected->idle on success", async () => {
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    expect(result.current.status).toBe("idle")
    expect(result.current.pendingMessage).toBeNull()
    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/send-message", expect.objectContaining({
      method: "POST",
    }))
  })

  it("sets error status on failed response", async () => {
    mockedAuthFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "Server error" }),
    } as Response)

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe("Server error")
  })

  it("sets error status on network error", async () => {
    mockedAuthFetch.mockRejectedValueOnce(new Error("Network failure"))

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe("Network failure")
  })

  it("ignores AbortError without setting error state", async () => {
    const abortError = new Error("Aborted")
    abortError.name = "AbortError"
    mockedAuthFetch.mockRejectedValueOnce(abortError)

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    // Should not set error for abort
    expect(result.current.error).toBeUndefined()
  })

  it("calls onCreateSession when no session exists", async () => {
    const onCreateSession = vi.fn().mockResolvedValue("new-session-id")

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: null,
        onCreateSession,
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    expect(onCreateSession).toHaveBeenCalledWith("hello", undefined)
  })

  it("resets state when onCreateSession returns null", async () => {
    const onCreateSession = vi.fn().mockResolvedValue(null)

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: null,
        onCreateSession,
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    expect(result.current.status).toBe("idle")
    expect(result.current.pendingMessage).toBeNull()
  })

  it("stopAgent aborts request and resets state", async () => {
    // Make fetch hang indefinitely
    mockedAuthFetch.mockImplementation(
      () => new Promise(() => {})
    )

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      })
    )

    // Start sending (don't await)
    act(() => {
      result.current.sendMessage("hello")
    })

    // Stop the agent
    await act(async () => {
      result.current.stopAgent()
    })

    expect(result.current.status).toBe("idle")
    expect(result.current.pendingMessage).toBeNull()
  })

  it("interrupt calls stop-session endpoint", () => {
    mockedAuthFetch.mockResolvedValue({} as Response)

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      })
    )

    act(() => {
      result.current.interrupt()
    })

    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/stop-session", expect.objectContaining({
      method: "POST",
    }))
  })

  it("interrupt does nothing without sessionId", () => {
    const { result } = renderHook(() =>
      usePtyChat({ sessionSource: null })
    )

    act(() => {
      result.current.interrupt()
    })

    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })

  it("clearPending clears pendingMessage", () => {
    const { result } = renderHook(() =>
      usePtyChat({ sessionSource: null })
    )

    act(() => {
      result.current.clearPending()
    })

    expect(result.current.pendingMessage).toBeNull()
  })

  it("uses parsedSessionId over fileName-based id when available", async () => {
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "old-id.jsonl", rawText: "" },
        parsedSessionId: "real-uuid-123",
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    const body = JSON.parse(
      (mockedAuthFetch.mock.calls[0][1] as RequestInit).body as string
    )
    expect(body.sessionId).toBe("real-uuid-123")
  })

  it("sets error on non-Error exception during sendMessage", async () => {
    mockedAuthFetch.mockRejectedValueOnce("string error")

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe("Unknown error")
  })

  it("uses default error message when response has no error field", async () => {
    mockedAuthFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as Response)

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    expect(result.current.error).toBe("Request failed (500)")
  })

  it("resets state when session changes (sessionId switches)", async () => {
    const source1 = { dirName: "proj", fileName: "sess1.jsonl", rawText: "" }
    const source2 = { dirName: "proj", fileName: "sess2.jsonl", rawText: "" }

    // First session has an error
    mockedAuthFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "Server error" }),
    } as Response)

    const { result, rerender } = renderHook(
      (props) => usePtyChat({ sessionSource: props.source }),
      { initialProps: { source: source1 as typeof source1 | null } }
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })
    expect(result.current.status).toBe("error")

    // Switch to different session
    rerender({ source: source2 })

    // State should be reset
    expect(result.current.status).toBe("idle")
    expect(result.current.error).toBeUndefined()
    expect(result.current.pendingMessage).toBeNull()
  })

  it("handles error in onCreateSession", async () => {
    const onCreateSession = vi.fn().mockRejectedValue(new Error("Create failed"))

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: null,
        onCreateSession,
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    expect(result.current.status).toBe("error")
    expect(result.current.error).toBe("Create failed")
    expect(result.current.pendingMessage).toBeNull()
  })

  it("calls onPermissionsApplied during sendMessage", async () => {
    const onPermissionsApplied = vi.fn()
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
        onPermissionsApplied,
      })
    )

    await act(async () => {
      await result.current.sendMessage("hello")
    })

    expect(onPermissionsApplied).toHaveBeenCalledTimes(1)
  })

  it("sends images in the request body", async () => {
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      })
    )

    const images = [{ data: "base64data", mediaType: "image/png" }]
    await act(async () => {
      await result.current.sendMessage("describe this", images)
    })

    const body = JSON.parse(
      (mockedAuthFetch.mock.calls[0][1] as RequestInit).body as string
    )
    expect(body.images).toEqual(images)
  })

  it("stopAgent does nothing without sessionId", () => {
    const { result } = renderHook(() =>
      usePtyChat({ sessionSource: null })
    )

    act(() => {
      result.current.stopAgent()
    })

    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })

  it("isConnected reflects connected status", async () => {
    // Make fetch hang
    mockedAuthFetch.mockImplementation(() => new Promise(() => {}))

    const { result } = renderHook(() =>
      usePtyChat({
        sessionSource: { dirName: "proj", fileName: "sess.jsonl", rawText: "" },
      })
    )

    expect(result.current.isConnected).toBe(false)

    // Start sending (don't await since it hangs)
    act(() => {
      result.current.sendMessage("hello")
    })

    // Now status should be "connected"
    expect(result.current.isConnected).toBe(true)
  })
})
