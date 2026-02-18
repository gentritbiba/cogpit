import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

// Mock auth module
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  isRemoteClient: vi.fn(() => false),
  getToken: vi.fn(() => null),
}))

import { useConfigValidation } from "@/hooks/useConfigValidation"
import { authFetch } from "@/lib/auth"

const mockAuthFetch = vi.mocked(authFetch)

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useConfigValidation", () => {
  describe("initial state", () => {
    it("starts with idle status and no error", () => {
      const { result } = renderHook(() => useConfigValidation())
      expect(result.current.status).toBe("idle")
      expect(result.current.error).toBeNull()
    })
  })

  describe("validate", () => {
    it("sets status to idle for empty/whitespace value", async () => {
      const { result } = renderHook(() => useConfigValidation())

      await act(async () => {
        await result.current.validate("   ")
      })

      expect(result.current.status).toBe("idle")
      expect(result.current.error).toBeNull()
      expect(mockAuthFetch).not.toHaveBeenCalled()
    })

    it("sets status to valid when API returns valid", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(JSON.stringify({ valid: true }), { status: 200 })
      )

      const { result } = renderHook(() => useConfigValidation())

      await act(async () => {
        await result.current.validate("/home/user/.claude")
      })

      expect(result.current.status).toBe("valid")
      expect(result.current.error).toBeNull()
      expect(mockAuthFetch).toHaveBeenCalledWith(
        `/api/config/validate?path=${encodeURIComponent("/home/user/.claude")}`
      )
    })

    it("sets status to invalid with error when API returns invalid", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ valid: false, error: "Directory not found" }),
          { status: 200 }
        )
      )

      const { result } = renderHook(() => useConfigValidation())

      await act(async () => {
        await result.current.validate("/bad/path")
      })

      expect(result.current.status).toBe("invalid")
      expect(result.current.error).toBe("Directory not found")
    })

    it("uses default error message when API returns invalid without error", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(JSON.stringify({ valid: false }), { status: 200 })
      )

      const { result } = renderHook(() => useConfigValidation())

      await act(async () => {
        await result.current.validate("/bad/path")
      })

      expect(result.current.status).toBe("invalid")
      expect(result.current.error).toBe("Invalid path")
    })

    it("sets status to invalid on fetch error", async () => {
      mockAuthFetch.mockRejectedValue(new Error("Network failure"))

      const { result } = renderHook(() => useConfigValidation())

      await act(async () => {
        await result.current.validate("/some/path")
      })

      expect(result.current.status).toBe("invalid")
      expect(result.current.error).toBe("Failed to validate path")
    })

    it("transitions through validating status", async () => {
      let resolvePromise: (value: Response) => void
      mockAuthFetch.mockReturnValue(
        new Promise((resolve) => {
          resolvePromise = resolve
        })
      )

      const { result } = renderHook(() => useConfigValidation())

      // Start validation but don't await
      let validatePromise: Promise<void>
      act(() => {
        validatePromise = result.current.validate("/some/path")
      })

      // Should be validating
      expect(result.current.status).toBe("validating")
      expect(result.current.error).toBeNull()

      // Resolve the fetch
      await act(async () => {
        resolvePromise!(
          new Response(JSON.stringify({ valid: true }), { status: 200 })
        )
        await validatePromise!
      })

      expect(result.current.status).toBe("valid")
    })
  })

  describe("debouncedValidate", () => {
    it("debounces validation by 400ms", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(JSON.stringify({ valid: true }), { status: 200 })
      )

      const { result } = renderHook(() => useConfigValidation())

      act(() => {
        result.current.debouncedValidate("/path1")
      })

      // Should not have called yet
      expect(mockAuthFetch).not.toHaveBeenCalled()

      // Advance 200ms - still should not have called
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(mockAuthFetch).not.toHaveBeenCalled()

      // Advance remaining 200ms - should trigger the setTimeout callback
      await act(async () => {
        vi.advanceTimersByTime(200)
        // Let the resolved promise from validate() settle
        await vi.runAllTimersAsync()
      })

      expect(mockAuthFetch).toHaveBeenCalledTimes(1)
    })

    it("cancels previous debounce when called again", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(JSON.stringify({ valid: true }), { status: 200 })
      )

      const { result } = renderHook(() => useConfigValidation())

      act(() => {
        result.current.debouncedValidate("/path1")
      })

      // Advance 300ms then call again - first timer not fired yet
      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(mockAuthFetch).not.toHaveBeenCalled()

      act(() => {
        result.current.debouncedValidate("/path2")
      })

      // Advance 400ms for the second call to fire
      await act(async () => {
        vi.advanceTimersByTime(400)
        await vi.runAllTimersAsync()
      })

      // Only the second path should have been validated
      expect(mockAuthFetch).toHaveBeenCalledTimes(1)
      expect(mockAuthFetch).toHaveBeenCalledWith(
        `/api/config/validate?path=${encodeURIComponent("/path2")}`
      )
    })
  })

  describe("reset", () => {
    it("resets status to idle and clears error", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ valid: false, error: "Bad" }),
          { status: 200 }
        )
      )

      const { result } = renderHook(() => useConfigValidation())

      await act(async () => {
        await result.current.validate("/bad")
      })

      expect(result.current.status).toBe("invalid")
      expect(result.current.error).toBe("Bad")

      act(() => result.current.reset())

      expect(result.current.status).toBe("idle")
      expect(result.current.error).toBeNull()
    })

    it("cancels pending debounced validation", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(JSON.stringify({ valid: true }), { status: 200 })
      )

      const { result } = renderHook(() => useConfigValidation())

      act(() => {
        result.current.debouncedValidate("/some/path")
      })

      act(() => result.current.reset())

      // Advance past debounce delay
      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(mockAuthFetch).not.toHaveBeenCalled()
    })
  })

  describe("save", () => {
    it("returns success result on successful save", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, claudeDir: "/saved/.claude" }),
          { status: 200 }
        )
      )

      const { result } = renderHook(() => useConfigValidation())

      let saveResult: { success: boolean; claudeDir?: string; error?: string }
      await act(async () => {
        saveResult = await result.current.save("/saved/.claude")
      })

      expect(saveResult!).toEqual({
        success: true,
        claudeDir: "/saved/.claude",
      })
      expect(mockAuthFetch).toHaveBeenCalledWith("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeDir: "/saved/.claude" }),
      })
    })

    it("passes networkOpts in the request body", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, claudeDir: "/path" }),
          { status: 200 }
        )
      )

      const { result } = renderHook(() => useConfigValidation())

      await act(async () => {
        await result.current.save("/path", {
          networkAccess: true,
          networkPassword: "secret",
        })
      })

      expect(mockAuthFetch).toHaveBeenCalledWith("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claudeDir: "/path",
          networkAccess: true,
          networkPassword: "secret",
        }),
      })
    })

    it("sets error and returns failure when API returns error", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, error: "Permission denied" }),
          { status: 400 }
        )
      )

      const { result } = renderHook(() => useConfigValidation())

      let saveResult: { success: boolean; claudeDir?: string; error?: string }
      await act(async () => {
        saveResult = await result.current.save("/forbidden")
      })

      expect(saveResult!).toEqual({
        success: false,
        error: "Permission denied",
      })
      expect(result.current.error).toBe("Permission denied")
      expect(result.current.status).toBe("invalid")
    })

    it("uses default error message when API returns error without message", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(
          JSON.stringify({ success: false }),
          { status: 400 }
        )
      )

      const { result } = renderHook(() => useConfigValidation())

      await act(async () => {
        await result.current.save("/bad")
      })

      expect(result.current.error).toBe("Failed to save")
    })

    it("handles network error during save", async () => {
      mockAuthFetch.mockRejectedValue(new Error("Connection lost"))

      const { result } = renderHook(() => useConfigValidation())

      let saveResult: { success: boolean; claudeDir?: string; error?: string }
      await act(async () => {
        saveResult = await result.current.save("/path")
      })

      expect(saveResult!).toEqual({
        success: false,
        error: "Network error",
      })
      expect(result.current.error).toBe("Failed to save configuration")
    })
  })

  describe("cleanup on unmount", () => {
    it("clears debounce timer on unmount", async () => {
      mockAuthFetch.mockResolvedValue(
        new Response(JSON.stringify({ valid: true }), { status: 200 })
      )

      const { result, unmount } = renderHook(() => useConfigValidation())

      act(() => {
        result.current.debouncedValidate("/some/path")
      })

      unmount()

      // Advance past debounce timer
      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      // Should not fire because the component unmounted
      expect(mockAuthFetch).not.toHaveBeenCalled()
    })
  })
})
