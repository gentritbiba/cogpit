import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

// Mock auth module
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  isRemoteClient: vi.fn(() => false),
  getToken: vi.fn(() => null),
}))

import { useAppConfig } from "@/hooks/useAppConfig"
import { authFetch, isRemoteClient, getToken } from "@/lib/auth"

const mockAuthFetch = vi.mocked(authFetch)
const mockIsRemoteClient = vi.mocked(isRemoteClient)
const mockGetToken = vi.mocked(getToken)

// Mock window.location.reload
const reloadMock = vi.fn()
Object.defineProperty(window, "location", {
  value: { ...window.location, reload: reloadMock },
  writable: true,
})

function mockConfigResponse(claudeDir: string | null = "/home/user/.claude") {
  mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/api/config")) {
      return new Response(
        JSON.stringify({ claudeDir }),
        { status: 200 }
      )
    }
    if (url.includes("/api/network-info")) {
      return new Response(
        JSON.stringify({ enabled: false }),
        { status: 200 }
      )
    }
    return new Response("not found", { status: 404 })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsRemoteClient.mockReturnValue(false)
  mockGetToken.mockReturnValue(null)
  reloadMock.mockClear()
})

describe("useAppConfig", () => {
  describe("initial loading", () => {
    it("starts in loading state", () => {
      mockConfigResponse()
      const { result } = renderHook(() => useAppConfig())
      // configLoading is initially true
      expect(result.current.configLoading).toBe(true)
    })

    it("loads config successfully", async () => {
      mockConfigResponse("/home/user/.claude")
      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      expect(result.current.claudeDir).toBe("/home/user/.claude")
      expect(result.current.configError).toBeNull()
    })

    it("handles config with null claudeDir", async () => {
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          return new Response(JSON.stringify({}), { status: 200 })
        }
        if (url.includes("/api/network-info")) {
          return new Response(JSON.stringify({ enabled: false }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      expect(result.current.claudeDir).toBeNull()
    })

    it("sets configError on fetch failure", async () => {
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          return new Response("Server Error", { status: 500 })
        }
        if (url.includes("/api/network-info")) {
          return new Response(JSON.stringify({ enabled: false }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      expect(result.current.configError).toContain("Config request failed")
      expect(result.current.claudeDir).toBeNull()
    })

    it("sets configError on network error", async () => {
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          throw new Error("Network error")
        }
        if (url.includes("/api/network-info")) {
          return new Response(JSON.stringify({ enabled: false }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      expect(result.current.configError).toBe("Network error")
    })

    it("stays in loading state for remote client without token", () => {
      mockIsRemoteClient.mockReturnValue(true)
      mockGetToken.mockReturnValue(null)

      const { result } = renderHook(() => useAppConfig())
      // Should stay in loading because effect returns early
      expect(result.current.configLoading).toBe(true)
    })

    it("loads config for remote client with token", async () => {
      mockIsRemoteClient.mockReturnValue(true)
      mockGetToken.mockReturnValue("valid-token")
      mockConfigResponse("/remote/.claude")

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      expect(result.current.claudeDir).toBe("/remote/.claude")
    })
  })

  describe("showConfigDialog", () => {
    it("starts with dialog closed", () => {
      mockConfigResponse()
      const { result } = renderHook(() => useAppConfig())
      expect(result.current.showConfigDialog).toBe(false)
    })

    it("opens config dialog", async () => {
      mockConfigResponse()
      const { result } = renderHook(() => useAppConfig())

      act(() => result.current.openConfigDialog())
      expect(result.current.showConfigDialog).toBe(true)
    })

    it("closes config dialog", async () => {
      mockConfigResponse()
      const { result } = renderHook(() => useAppConfig())

      act(() => result.current.openConfigDialog())
      expect(result.current.showConfigDialog).toBe(true)

      act(() => result.current.handleCloseConfigDialog())
      expect(result.current.showConfigDialog).toBe(false)
    })
  })

  describe("handleConfigSaved", () => {
    it("reloads when path changes", async () => {
      mockConfigResponse()
      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })

      act(() => result.current.openConfigDialog())
      act(() => result.current.handleConfigSaved("/new/path/.claude"))

      expect(result.current.claudeDir).toBe("/new/path/.claude")
      expect(result.current.showConfigDialog).toBe(false)
      expect(reloadMock).toHaveBeenCalled()
    })

    it("does not reload for network-only changes (same path)", async () => {
      mockConfigResponse("/home/user/.claude")
      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      expect(result.current.claudeDir).toBe("/home/user/.claude")

      act(() => result.current.openConfigDialog())
      act(() => result.current.handleConfigSaved("/home/user/.claude"))

      expect(result.current.showConfigDialog).toBe(false)
      expect(reloadMock).not.toHaveBeenCalled()
    })

    it("re-fetches network info for network-only changes", async () => {
      // Start with network disabled
      mockConfigResponse("/home/user/.claude")
      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })

      // Now mock network-info to return enabled
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/network-info")) {
          return new Response(
            JSON.stringify({ enabled: true, url: "http://192.168.1.5:19384" }),
            { status: 200 }
          )
        }
        return new Response("not found", { status: 404 })
      })

      act(() => result.current.handleConfigSaved("/home/user/.claude"))

      await waitFor(() => {
        expect(result.current.networkUrl).toBe("http://192.168.1.5:19384")
      })
      expect(result.current.networkAccessDisabled).toBe(false)
      expect(reloadMock).not.toHaveBeenCalled()
    })
  })

  describe("retryConfig", () => {
    it("retries fetching config", async () => {
      // First load fails
      let callCount = 0
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          callCount++
          if (callCount === 1) {
            return new Response("error", { status: 500 })
          }
          return new Response(JSON.stringify({ claudeDir: "/retry/.claude" }), { status: 200 })
        }
        if (url.includes("/api/network-info")) {
          return new Response(JSON.stringify({ enabled: false }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      expect(result.current.configError).not.toBeNull()

      await act(async () => {
        result.current.retryConfig()
      })

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      expect(result.current.claudeDir).toBe("/retry/.claude")
      expect(result.current.configError).toBeNull()
    })
  })

  describe("network info", () => {
    it("sets networkUrl when network is enabled", async () => {
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          return new Response(JSON.stringify({ claudeDir: "/test" }), { status: 200 })
        }
        if (url.includes("/api/network-info")) {
          return new Response(
            JSON.stringify({ enabled: true, url: "https://example.com:3000" }),
            { status: 200 }
          )
        }
        return new Response("not found", { status: 404 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.networkUrl).toBe("https://example.com:3000")
      })
      expect(result.current.networkAccessDisabled).toBe(false)
    })

    it("sets networkAccessDisabled when network is disabled", async () => {
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          return new Response(JSON.stringify({ claudeDir: "/test" }), { status: 200 })
        }
        if (url.includes("/api/network-info")) {
          return new Response(JSON.stringify({ enabled: false }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      await waitFor(() => {
        expect(result.current.networkAccessDisabled).toBe(true)
      })
      expect(result.current.networkUrl).toBeNull()
    })

    it("handles network info fetch error gracefully", async () => {
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          return new Response(JSON.stringify({ claudeDir: "/test" }), { status: 200 })
        }
        if (url.includes("/api/network-info")) {
          throw new Error("Network error")
        }
        return new Response("not found", { status: 404 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      // Should fallback gracefully
      expect(result.current.networkUrl).toBeNull()
      expect(result.current.networkAccessDisabled).toBe(false)
    })
  })

  describe("retryConfig edge cases", () => {
    it("sets configError on network failure during retry", async () => {
      // First load succeeds
      mockConfigResponse("/home/user/.claude")

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })

      // Make retry fail with network error
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          throw new Error("Retry failed")
        }
        if (url.includes("/api/network-info")) {
          return new Response(JSON.stringify({ enabled: false }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      })

      await act(async () => {
        result.current.retryConfig()
      })

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      expect(result.current.configError).toBe("Retry failed")
      expect(result.current.claudeDir).toBeNull()
    })

    it("sets non-Error configError message for non-Error exceptions", async () => {
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          throw "string error"
        }
        if (url.includes("/api/network-info")) {
          return new Response(JSON.stringify({ enabled: false }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      expect(result.current.configError).toBe("Failed to load configuration")
    })
  })

  describe("network info edge cases", () => {
    it("sets networkUrl to null when enabled but no url", async () => {
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          return new Response(JSON.stringify({ claudeDir: "/test" }), { status: 200 })
        }
        if (url.includes("/api/network-info")) {
          return new Response(
            JSON.stringify({ enabled: true }),
            { status: 200 }
          )
        }
        return new Response("not found", { status: 404 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      // enabled: true but no url → networkUrl should be null
      expect(result.current.networkUrl).toBeNull()
    })
  })

  describe("auth state changes", () => {
    it("re-fetches config when cogpit-auth-changed event fires", async () => {
      let fetchCount = 0
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          fetchCount++
          return new Response(
            JSON.stringify({ claudeDir: `/path-${fetchCount}` }),
            { status: 200 }
          )
        }
        if (url.includes("/api/network-info")) {
          return new Response(JSON.stringify({ enabled: false }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      const firstDir = result.current.claudeDir

      // Simulate auth change event
      act(() => {
        window.dispatchEvent(new Event("cogpit-auth-changed"))
      })

      await waitFor(() => {
        expect(result.current.claudeDir).not.toBe(firstDir)
      })
    })
  })
})
