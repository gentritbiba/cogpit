import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import { useKillAll } from "../useKillAll"

const mockedAuthFetch = vi.mocked(authFetch)

describe("useKillAll", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("returns initial state with killing=false", () => {
    const { result } = renderHook(() => useKillAll())
    expect(result.current.killing).toBe(false)
    expect(typeof result.current.handleKillAll).toBe("function")
  })

  it("sets killing=true immediately when handleKillAll is called", async () => {
    mockedAuthFetch.mockResolvedValue(new Response())

    const { result } = renderHook(() => useKillAll())

    await act(async () => {
      result.current.handleKillAll()
    })

    // killing is true until the 1500ms timeout fires
    expect(result.current.killing).toBe(true)
  })

  it("calls authFetch with POST /api/kill-all", async () => {
    mockedAuthFetch.mockResolvedValue(new Response())

    const { result } = renderHook(() => useKillAll())

    await act(async () => {
      result.current.handleKillAll()
    })

    expect(mockedAuthFetch).toHaveBeenCalledWith("/api/kill-all", {
      method: "POST",
    })
  })

  it("resets killing to false after 1500ms timeout", async () => {
    mockedAuthFetch.mockResolvedValue(new Response())

    const { result } = renderHook(() => useKillAll())

    await act(async () => {
      result.current.handleKillAll()
    })

    expect(result.current.killing).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1500)
    })

    expect(result.current.killing).toBe(false)
  })

  it("resets killing after timeout even when authFetch rejects", async () => {
    mockedAuthFetch.mockRejectedValue(new Error("Network error"))

    const { result } = renderHook(() => useKillAll())

    await act(async () => {
      result.current.handleKillAll()
    })

    expect(result.current.killing).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1500)
    })

    expect(result.current.killing).toBe(false)
  })

  it("does not reset killing before 1500ms", async () => {
    mockedAuthFetch.mockResolvedValue(new Response())

    const { result } = renderHook(() => useKillAll())

    await act(async () => {
      result.current.handleKillAll()
    })

    act(() => {
      vi.advanceTimersByTime(1000)
    })

    expect(result.current.killing).toBe(true)

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(result.current.killing).toBe(false)
  })
})
