import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

// Mock auth module
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  hubFetch: vi.fn(),
  isRemoteClient: vi.fn(() => false),
}))

import { useAppConfig } from "@/hooks/useAppConfig"
import { authFetch, hubFetch, isRemoteClient } from "@/lib/auth"

const mockAuthFetch = vi.mocked(authFetch)
const mockHubFetch = vi.mocked(hubFetch)
const mockIsRemoteClient = vi.mocked(isRemoteClient)

// Mock window.location.reload
const reloadMock = vi.fn()
Object.defineProperty(window, "location", {
  value: { ...window.location, reload: reloadMock },
  writable: true,
})

/**
 * Mock the hub-scoped network-info endpoint. Uses mockImplementation (not
 * mockResolvedValue) so every call gets a FRESH Response — refreshNetwork runs
 * more than once and a reused Response body can only be read a single time.
 */
function mockNetworkInfo(body: { enabled: boolean; url?: string }) {
  mockHubFetch.mockImplementation(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  )
}

/** Default hub-scoped network-info response (disabled). */
function mockNetworkDisabled() {
  mockNetworkInfo({ enabled: false })
}

function mockConfigResponse(claudeDir: string | null = "/home/user/.claude") {
  // /api/config is intentionally per-device → authFetch. /api/network-info is
  // hub-local → hubFetch (see mockNetworkDisabled / per-test overrides).
  mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/api/config")) {
      return new Response(
        JSON.stringify({ claudeDir }),
        { status: 200 }
      )
    }
    return new Response("not found", { status: 404 })
  })
  mockNetworkDisabled()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsRemoteClient.mockReturnValue(false)
  // network-info goes through hubFetch; default to disabled unless a test overrides.
  mockNetworkDisabled()
  reloadMock.mockClear()
})

describe("useAppConfig", () => {
  describe("initial loading", () => {
    it("starts in loading state", async () => {
      mockConfigResponse()
      const { result } = renderHook(() => useAppConfig())
      // configLoading is initially true
      expect(result.current.configLoading).toBe(true)
      await waitFor(() => expect(result.current.networkAccessDisabled).toBe(true))
    })

    it("loads config successfully", async () => {
      mockConfigResponse("/home/user/.claude")
      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => expect(result.current.networkAccessDisabled).toBe(true))
      expect(result.current.claudeDir).toBe("/home/user/.claude")
      expect(result.current.configError).toBeNull()
    })

    it("uses the configured provider for dashboard controls", async () => {
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          return new Response(JSON.stringify({ claudeDir: "/compat/.claude", mode: "codex" }), { status: 200 })
        }
        return new Response(JSON.stringify({ enabled: false }), { status: 200 })
      })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => expect(result.current.configLoading).toBe(false))
      expect(result.current.defaultAgentKind).toBe("codex")
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

      await waitFor(() => expect(result.current.networkAccessDisabled).toBe(true))
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

    it("uses the HttpOnly browser session for remote clients", async () => {
      mockIsRemoteClient.mockReturnValue(true)
      mockConfigResponse("/remote/.claude")

      const { result } = renderHook(() => useAppConfig())
      await waitFor(() => expect(result.current.configLoading).toBe(false))
      expect(result.current.claudeDir).toBe("/remote/.claude")
    })
  })

  describe("showConfigDialog", () => {
    it("starts with dialog closed", async () => {
      mockConfigResponse()
      const { result } = renderHook(() => useAppConfig())
      expect(result.current.showConfigDialog).toBe(false)
      await waitFor(() => expect(result.current.networkAccessDisabled).toBe(true))
    })

    it("opens config dialog", async () => {
      mockConfigResponse()
      const { result } = renderHook(() => useAppConfig())

      act(() => result.current.openConfigDialog())
      expect(result.current.showConfigDialog).toBe(true)
      await waitFor(() => expect(result.current.networkAccessDisabled).toBe(true))
    })

    it("closes config dialog", async () => {
      mockConfigResponse()
      const { result } = renderHook(() => useAppConfig())

      act(() => result.current.openConfigDialog())
      expect(result.current.showConfigDialog).toBe(true)

      act(() => result.current.handleCloseConfigDialog())
      expect(result.current.showConfigDialog).toBe(false)
      await waitFor(() => expect(result.current.networkAccessDisabled).toBe(true))
    })
  })

  describe("handleConfigSaved", () => {
    it("reloads when path changes", async () => {
      mockConfigResponse()
      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => expect(result.current.networkAccessDisabled).toBe(true))
      mockNetworkInfo({ enabled: true, url: "http://reload-check.local" })

      act(() => result.current.openConfigDialog())
      act(() => result.current.handleConfigSaved("/new/path/.claude"))

      expect(result.current.claudeDir).toBe("/new/path/.claude")
      expect(result.current.showConfigDialog).toBe(false)
      expect(reloadMock).toHaveBeenCalled()
      await waitFor(() => expect(result.current.networkUrl).toBe("http://reload-check.local"))
    })

    it("does not reload for network-only changes (same path)", async () => {
      mockConfigResponse("/home/user/.claude")
      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => expect(result.current.networkAccessDisabled).toBe(true))
      expect(result.current.claudeDir).toBe("/home/user/.claude")
      mockNetworkInfo({ enabled: true, url: "http://network-refresh.local" })

      act(() => result.current.openConfigDialog())
      act(() => result.current.handleConfigSaved("/home/user/.claude"))

      expect(result.current.showConfigDialog).toBe(false)
      expect(reloadMock).not.toHaveBeenCalled()
      await waitFor(() => expect(result.current.networkUrl).toBe("http://network-refresh.local"))
    })

    it("re-fetches network info for network-only changes", async () => {
      // Start with network disabled
      mockConfigResponse("/home/user/.claude")
      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })

      // Now mock network-info (hub-scoped) to return enabled
      mockNetworkInfo({ enabled: true, url: "http://192.168.1.5:19384" })

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
        return new Response("not found", { status: 404 })
      })
      mockNetworkInfo({ enabled: true, url: "https://example.com:3000" })

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
        return new Response("not found", { status: 404 })
      })
      // hubFetch defaults to disabled (beforeEach)

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
        return new Response("not found", { status: 404 })
      })
      mockHubFetch.mockRejectedValue(new Error("Network error"))

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.configLoading).toBe(false)
      })
      // Should fallback gracefully
      expect(result.current.networkUrl).toBeNull()
      expect(result.current.networkAccessDisabled).toBe(false)
    })

    it("fetches network-info from the hub, never the active device", async () => {
      // authFetch device-prefixes to the active remote device; hubFetch always
      // targets the hub. network-info is the hub's own LAN URL, so it must go
      // through hubFetch — otherwise the header shows the remote box's URL.
      mockAuthFetch.mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.includes("/api/config")) {
          return new Response(JSON.stringify({ claudeDir: "/test" }), { status: 200 })
        }
        return new Response("not found", { status: 404 })
      })
      mockNetworkInfo({ enabled: true, url: "http://hub.local:19384" })

      const { result } = renderHook(() => useAppConfig())

      await waitFor(() => {
        expect(result.current.networkUrl).toBe("http://hub.local:19384")
      })

      expect(mockHubFetch).toHaveBeenCalledWith(
        "/api/network-info",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
      const authTouchedNetwork = mockAuthFetch.mock.calls.some(([input]) => {
        const url = typeof input === "string" ? input : String(input)
        return url.includes("/api/network-info")
      })
      expect(authTouchedNetwork).toBe(false)
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
        return new Response("not found", { status: 404 })
      })
      mockNetworkInfo({ enabled: true })

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
