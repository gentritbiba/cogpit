import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useMcpServers } from "../useMcpServers"

// Mock authFetch
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { authFetch } from "@/lib/auth"

const mockFetch = authFetch as unknown as ReturnType<typeof vi.fn>

describe("useMcpServers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it("fetches servers and auto-selects connected ones", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          { name: "clickup", status: "connected" },
          { name: "gmail", status: "needs_auth" },
        ],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    // Wait for fetch
    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    // Connected servers auto-selected, auth ones not
    expect(result.current.selectedServers).toEqual(["clickup"])
  })

  it("persists selection to localStorage", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          { name: "clickup", status: "connected" },
          { name: "figma", status: "connected" },
        ],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    // Deselect figma
    act(() => result.current.toggleServer("figma"))
    expect(result.current.selectedServers).toEqual(["clickup"])

    // Check localStorage
    const stored = JSON.parse(localStorage.getItem("cogpit:mcpSelection:test-dir") || "null")
    expect(stored).toEqual(["clickup"])
  })

  it("loads saved selection from localStorage", async () => {
    localStorage.setItem("cogpit:mcpSelection:test-dir", JSON.stringify(["figma"]))

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          { name: "clickup", status: "connected" },
          { name: "figma", status: "connected" },
        ],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    // Should use stored selection, not auto-select
    expect(result.current.selectedServers).toEqual(["figma"])
  })

  it("returns disallowedMcpTools for unselected servers", async () => {
    localStorage.setItem("cogpit:mcpSelection:test-dir", JSON.stringify(["clickup"]))

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          { name: "clickup", status: "connected" },
          { name: "figma", status: "connected" },
        ],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    expect(result.current.disallowedMcpTools).toEqual(["mcp__figma__*"])
  })

  it("returns initial empty state", () => {
    const { result } = renderHook(() => useMcpServers(undefined, undefined))

    expect(result.current.servers).toEqual([])
    expect(result.current.selectedServers).toEqual([])
    expect(result.current.disallowedMcpTools).toEqual([])
    expect(result.current.loading).toBe(false)
    expect(typeof result.current.toggleServer).toBe("function")
    expect(typeof result.current.refresh).toBe("function")
  })

  it("does not fetch when cwd is undefined", () => {
    renderHook(() => useMcpServers(undefined, "test-dir"))
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("toggleServer adds a server when not selected", async () => {
    localStorage.setItem("cogpit:mcpSelection:test-dir", JSON.stringify(["clickup"]))

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          { name: "clickup", status: "connected" },
          { name: "figma", status: "connected" },
        ],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    // Initially only clickup selected
    expect(result.current.selectedServers).toEqual(["clickup"])

    // Toggle figma on
    act(() => result.current.toggleServer("figma"))
    expect(result.current.selectedServers).toEqual(["clickup", "figma"])
  })

  it("refresh calls API with refresh=1 param", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: [{ name: "clickup", status: "connected" }],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(1)
    })

    act(() => result.current.refresh())

    // Should have been called twice: initial fetch + refresh
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    const refreshCallUrl = mockFetch.mock.calls[1][0] as string
    expect(refreshCallUrl).toContain("refresh=1")
  })

  it("filters out saved servers that are no longer connected", async () => {
    // Saved selection includes "figma" which is now in error state
    localStorage.setItem("cogpit:mcpSelection:test-dir", JSON.stringify(["clickup", "figma"]))

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        servers: [
          { name: "clickup", status: "connected" },
          { name: "figma", status: "error" },
        ],
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    await vi.waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    // figma should be filtered out since it's not connected anymore
    expect(result.current.selectedServers).toEqual(["clickup"])
  })

  it("handles API error gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"))

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    // Should not crash, stays in empty state
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.servers).toEqual([])
    expect(result.current.selectedServers).toEqual([])
  })

  it("handles non-ok response gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir"))

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.servers).toEqual([])
  })
})
