import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useMcpServers } from "../useMcpServers"

// Mock authFetch
vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

// Selections persist in the server-side session config store; mock it with an
// in-memory map so tests control saved state per key.
const { configStore } = vi.hoisted(() => ({
  configStore: new Map<string, { mcpServers?: string[] }>(),
}))
vi.mock("@/lib/sessionConfig", () => ({
  fetchSessionConfig: vi.fn(async (key: string) => configStore.get(key) ?? null),
  saveSessionConfig: vi.fn((key: string, patch: { mcpServers?: string[] }) => {
    configStore.set(key, { ...configStore.get(key), ...patch })
  }),
}))

import { authFetch } from "@/lib/auth"

const mockFetch = authFetch as unknown as ReturnType<typeof vi.fn>

function setSavedSelection(key: string, selection: string[]) {
  configStore.set(key, { mcpServers: selection })
}

function getSavedSelection(key: string): string[] | null {
  return configStore.get(key)?.mcpServers ?? null
}

const MOCK_CONFIGS = {
  clickup: { command: "npx", args: ["-y", "mcp-clickup"] },
  figma: { command: "npx", args: ["-y", "@figma/mcp"] },
  gmail: { command: "npx", args: ["-y", "mcp-gmail"] },
  broken: { command: "npx", args: ["-y", "mcp-broken"] },
}

function mockServerResponse(
  servers: Array<{ name: string; status: "connected" | "needs_auth" | "error" }>,
  configs = MOCK_CONFIGS as Record<string, Record<string, unknown>>,
) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ servers, configs }),
  })
}

describe("useMcpServers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    configStore.clear()
  })

  it("fetches servers and auto-selects connected ones", async () => {
    mockServerResponse([
      { name: "clickup", status: "connected" },
      { name: "gmail", status: "needs_auth" },
    ])

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    expect(result.current.selectedServers).toEqual(["clickup"])
  })

  it("persists selection to the session config store", async () => {
    mockServerResponse([
      { name: "clickup", status: "connected" },
      { name: "figma", status: "connected" },
    ])

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    act(() => result.current.toggleServer("figma"))
    expect(result.current.selectedServers).toEqual(["clickup"])

    expect(getSavedSelection("test-dir")).toEqual(["clickup"])
  })

  it("loads saved selection from the session config store", async () => {
    setSavedSelection("test-dir", ["figma"])

    mockServerResponse([
      { name: "clickup", status: "connected" },
      { name: "figma", status: "connected" },
    ])

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    expect(result.current.selectedServers).toEqual(["figma"])
  })

  it("returns mcpConfigJson with only selected server configs", async () => {
    setSavedSelection("test-dir", ["clickup"])

    mockServerResponse([
      { name: "clickup", status: "connected" },
      { name: "figma", status: "connected" },
    ])

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    // Only clickup selected, so mcpConfigJson should include only clickup config
    const parsed = JSON.parse(result.current.mcpConfigJson!)
    expect(parsed.mcpServers).toHaveProperty("clickup")
    expect(parsed.mcpServers).not.toHaveProperty("figma")
  })

  it("returns null mcpConfigJson when all connected servers are selected", async () => {
    mockServerResponse([
      { name: "clickup", status: "connected" },
      { name: "figma", status: "connected" },
    ])

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    // All connected servers auto-selected → null (use default config)
    expect(result.current.mcpConfigJson).toBeNull()
  })

  it("returns empty mcpServers config when 0 selected", async () => {
    setSavedSelection("test-dir", [])

    mockServerResponse([
      { name: "clickup", status: "connected" },
      { name: "figma", status: "connected" },
    ])

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    const parsed = JSON.parse(result.current.mcpConfigJson!)
    expect(parsed.mcpServers).toEqual({})
  })

  it("returns initial empty state", () => {
    const { result } = renderHook(() => useMcpServers(undefined, undefined, undefined))

    expect(result.current.servers).toEqual([])
    expect(result.current.selectedServers).toEqual([])
    expect(result.current.mcpConfigJson).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.loaded).toBe(false)
    expect(typeof result.current.toggleServer).toBe("function")
    expect(typeof result.current.refresh).toBe("function")
  })

  it("sets loaded=true after fetch completes", async () => {
    mockServerResponse([{ name: "clickup", status: "connected" }])

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))
    expect(result.current.loaded).toBe(false)

    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    expect(result.current.servers.length).toBe(1)
  })

  it("sets loaded=true even on fetch error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"))

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    expect(result.current.servers).toEqual([])
  })

  it("does not fetch when cwd is undefined", () => {
    renderHook(() => useMcpServers(undefined, "test-dir", undefined))
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("toggleServer adds a server when not selected", async () => {
    setSavedSelection("test-dir", ["clickup"])

    mockServerResponse([
      { name: "clickup", status: "connected" },
      { name: "figma", status: "connected" },
    ])

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    expect(result.current.selectedServers).toEqual(["clickup"])

    act(() => result.current.toggleServer("figma"))
    expect(result.current.selectedServers).toEqual(["clickup", "figma"])
  })

  it("refresh calls API with refresh=1 param", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        servers: [{ name: "clickup", status: "connected" }],
        configs: MOCK_CONFIGS,
      }),
    })

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.servers.length).toBe(1)
    })

    act(() => result.current.refresh())

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    const refreshCallUrl = mockFetch.mock.calls[1][0] as string
    expect(refreshCallUrl).toContain("refresh=1")
  })

  it("filters out saved servers that are no longer connected", async () => {
    setSavedSelection("test-dir", ["clickup", "figma"])

    mockServerResponse([
      { name: "clickup", status: "connected" },
      { name: "figma", status: "error" },
    ])

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.servers.length).toBe(2)
    })

    expect(result.current.selectedServers).toEqual(["clickup"])
  })

  it("handles API error gracefully", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"))

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
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

    const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
    })

    expect(result.current.servers).toEqual([])
  })

  describe("session switch selection", () => {
    it("resets to auto-select-all when switching to a session with no saved selection", async () => {
      // Session A has custom selection
      setSavedSelection("session-a.jsonl", ["clickup"])

      mockServerResponse([
        { name: "clickup", status: "connected" },
        { name: "figma", status: "connected" },
      ])

      // Start with session A
      const { result, rerender } = renderHook(
        ({ sessionFileName }) => useMcpServers("/test/path", "test-dir", sessionFileName),
        { initialProps: { sessionFileName: "session-a.jsonl" as string | undefined } },
      )

      await waitFor(() => {
        expect(result.current.servers.length).toBe(2)
      })
      expect(result.current.selectedServers).toEqual(["clickup"])

      // Switch to session B (no saved selection)
      rerender({ sessionFileName: "session-b.jsonl" })

      // Should auto-select all connected servers, NOT keep session A's selection
      await waitFor(() => {
        expect(result.current.selectedServers).toEqual(expect.arrayContaining(["clickup", "figma"]))
      })
      expect(result.current.selectedServers).toHaveLength(2)
    })

    it("inherits project-level selection when switching to session with no saved selection", async () => {
      // Project-level default: only clickup
      setSavedSelection("test-dir", ["clickup"])

      mockServerResponse([
        { name: "clickup", status: "connected" },
        { name: "figma", status: "connected" },
      ])

      // Start with session A (has its own selection)
      setSavedSelection("session-a.jsonl", ["figma"])
      const { result, rerender } = renderHook(
        ({ sessionFileName }) => useMcpServers("/test/path", "test-dir", sessionFileName),
        { initialProps: { sessionFileName: "session-a.jsonl" as string | undefined } },
      )

      await waitFor(() => {
        expect(result.current.servers.length).toBe(2)
      })
      expect(result.current.selectedServers).toEqual(["figma"])

      // Switch to session B (no saved selection → should inherit project default)
      rerender({ sessionFileName: "session-b.jsonl" })

      await waitFor(() => {
        expect(result.current.selectedServers).toEqual(["clickup"])
      })
    })
  })

  describe("project switch (cwd change)", () => {
    it("resets servers and selection immediately when cwd changes", async () => {
      mockServerResponse([
        { name: "clickup", status: "connected" },
        { name: "figma", status: "connected" },
      ])

      const { result, rerender } = renderHook(
        ({ cwd }) => useMcpServers(cwd, "test-dir", undefined),
        { initialProps: { cwd: "/project-a" } },
      )

      await waitFor(() => {
        expect(result.current.servers.length).toBe(2)
      })
      expect(result.current.selectedServers).toEqual(["clickup", "figma"])

      // Switch project — mock new response (different servers)
      mockServerResponse([
        { name: "slack", status: "connected" },
      ], { slack: { command: "npx", args: ["-y", "mcp-slack"] } })

      rerender({ cwd: "/project-b" })

      // Should immediately clear old data
      expect(result.current.servers).toEqual([])
      expect(result.current.selectedServers).toEqual([])

      // Then load new data
      await waitFor(() => {
        expect(result.current.servers.length).toBe(1)
      })
      expect(result.current.servers[0].name).toBe("slack")
      expect(result.current.selectedServers).toEqual(["slack"])
    })
  })

  describe("refresh behavior", () => {
    it("does NOT auto-select newly connected servers on refresh", async () => {
      // Initial: only clickup connected
      mockServerResponse([
        { name: "clickup", status: "connected" },
        { name: "figma", status: "needs_auth" },
      ])

      const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

      await waitFor(() => {
        expect(result.current.servers.length).toBe(2)
      })
      expect(result.current.selectedServers).toEqual(["clickup"])

      // Refresh: figma is now connected
      mockServerResponse([
        { name: "clickup", status: "connected" },
        { name: "figma", status: "connected" },
      ])

      act(() => result.current.refresh())

      await waitFor(() => {
        expect(result.current.servers.filter(s => s.status === "connected")).toHaveLength(2)
      })

      // figma should NOT be auto-selected — user must opt in
      expect(result.current.selectedServers).toEqual(["clickup"])
    })

    it("removes disconnected servers from selection on refresh", async () => {
      mockServerResponse([
        { name: "clickup", status: "connected" },
        { name: "figma", status: "connected" },
      ])

      const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

      await waitFor(() => {
        expect(result.current.servers.length).toBe(2)
      })
      expect(result.current.selectedServers).toEqual(["clickup", "figma"])

      // Refresh: figma disconnected
      mockServerResponse([
        { name: "clickup", status: "connected" },
        { name: "figma", status: "error" },
      ])

      act(() => result.current.refresh())

      await waitFor(() => {
        expect(result.current.servers.find(s => s.name === "figma")?.status).toBe("error")
      })

      expect(result.current.selectedServers).toEqual(["clickup"])
    })
  })

  describe("mcpConfigJson edge cases", () => {
    it("falls back to null when selected server has no matching config", async () => {

      // Server "mystery" exists but has no config
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          servers: [
            { name: "clickup", status: "connected" },
            { name: "mystery", status: "connected" },
          ],
          configs: { clickup: MOCK_CONFIGS.clickup }, // no config for "mystery"
        }),
      })

      // Save selection with only clickup (not mystery)
      setSavedSelection("test-dir", ["clickup"])

      const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

      await waitFor(() => {
        expect(result.current.servers.length).toBe(2)
      })

      // Only clickup is selected and has config → should work normally
      expect(result.current.mcpConfigJson).not.toBeNull()
      const parsed = JSON.parse(result.current.mcpConfigJson!)
      expect(parsed.mcpServers).toHaveProperty("clickup")

      // Now select mystery too (no config)
      act(() => result.current.toggleServer("mystery"))

      // All connected selected → null (use defaults)
      expect(result.current.mcpConfigJson).toBeNull()

      // Deselect clickup — now only mystery selected (no config)
      act(() => result.current.toggleServer("clickup"))

      // Should fall back to null because mystery has no config
      expect(result.current.mcpConfigJson).toBeNull()
    })

    it("validates all selected servers exist in connected set for allSelected check", async () => {
      mockServerResponse([
        { name: "clickup", status: "connected" },
        { name: "figma", status: "connected" },
      ])

      const { result } = renderHook(() => useMcpServers("/test/path", "test-dir", undefined))

      await waitFor(() => {
        expect(result.current.servers.length).toBe(2)
      })

      // Both auto-selected → allSelected → null
      expect(result.current.mcpConfigJson).toBeNull()

      // Deselect one → not all selected → should have config
      act(() => result.current.toggleServer("figma"))
      expect(result.current.mcpConfigJson).not.toBeNull()
      const parsed = JSON.parse(result.current.mcpConfigJson!)
      expect(parsed.mcpServers).toHaveProperty("clickup")
      expect(parsed.mcpServers).not.toHaveProperty("figma")
    })
  })

})
