import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useServerPanel } from "../useServerPanel"

describe("useServerPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns initial state with empty maps/sets", () => {
    const { result } = renderHook(() => useServerPanel(null))
    expect(result.current.serverMap.size).toBe(0)
    expect(result.current.visibleServerIds.size).toBe(0)
    expect(result.current.serverPanelCollapsed).toBe(false)
    expect(typeof result.current.handleToggleServerCollapse).toBe("function")
    expect(typeof result.current.handleServersChanged).toBe("function")
    expect(typeof result.current.handleToggleServer).toBe("function")
  })

  it("handleToggleServerCollapse toggles collapsed state", () => {
    const { result } = renderHook(() => useServerPanel("session-1"))

    expect(result.current.serverPanelCollapsed).toBe(false)

    act(() => {
      result.current.handleToggleServerCollapse()
    })
    expect(result.current.serverPanelCollapsed).toBe(true)

    act(() => {
      result.current.handleToggleServerCollapse()
    })
    expect(result.current.serverPanelCollapsed).toBe(false)
  })

  it("handleServersChanged updates the server map", () => {
    const { result } = renderHook(() => useServerPanel("session-1"))

    act(() => {
      result.current.handleServersChanged([
        { id: "s1", outputPath: "/out/s1", title: "Server 1" },
        { id: "s2", outputPath: "/out/s2", title: "Server 2" },
      ])
    })

    expect(result.current.serverMap.size).toBe(2)
    expect(result.current.serverMap.get("s1")).toEqual({
      outputPath: "/out/s1",
      title: "Server 1",
    })
    expect(result.current.serverMap.get("s2")).toEqual({
      outputPath: "/out/s2",
      title: "Server 2",
    })
  })

  it("handleServersChanged does not trigger update when data is identical", () => {
    const { result } = renderHook(() => useServerPanel("session-1"))

    const servers = [
      { id: "s1", outputPath: "/out/s1", title: "Server 1" },
    ]

    act(() => {
      result.current.handleServersChanged(servers)
    })

    const mapRef1 = result.current.serverMap

    act(() => {
      result.current.handleServersChanged([...servers])
    })

    // Should be the same reference (no update)
    expect(result.current.serverMap).toBe(mapRef1)
  })

  it("handleServersChanged cleans up visibleServerIds for removed servers", () => {
    const { result } = renderHook(() => useServerPanel("session-1"))

    // Add servers and toggle one visible
    act(() => {
      result.current.handleServersChanged([
        { id: "s1", outputPath: "/out/s1", title: "Server 1" },
        { id: "s2", outputPath: "/out/s2", title: "Server 2" },
      ])
    })

    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })
    act(() => {
      result.current.handleToggleServer("s2", "/out/s2", "Server 2")
    })

    expect(result.current.visibleServerIds.has("s1")).toBe(true)
    expect(result.current.visibleServerIds.has("s2")).toBe(true)

    // Remove s2 from servers
    act(() => {
      result.current.handleServersChanged([
        { id: "s1", outputPath: "/out/s1", title: "Server 1" },
      ])
    })

    expect(result.current.visibleServerIds.has("s1")).toBe(true)
    expect(result.current.visibleServerIds.has("s2")).toBe(false)
  })

  it("handleToggleServer adds a server to visible set", () => {
    const { result } = renderHook(() => useServerPanel("session-1"))

    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })

    expect(result.current.visibleServerIds.has("s1")).toBe(true)
    // Also adds to serverMap
    expect(result.current.serverMap.get("s1")).toEqual({
      outputPath: "/out/s1",
      title: "Server 1",
    })
  })

  it("handleToggleServer removes a server from visible set on second call", () => {
    const { result } = renderHook(() => useServerPanel("session-1"))

    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })
    expect(result.current.visibleServerIds.has("s1")).toBe(true)

    act(() => {
      result.current.handleToggleServer("s1")
    })
    expect(result.current.visibleServerIds.has("s1")).toBe(false)
  })

  it("handleToggleServer un-collapses panel when adding a server", () => {
    const { result } = renderHook(() => useServerPanel("session-1"))

    // Collapse the panel
    act(() => {
      result.current.handleToggleServerCollapse()
    })
    expect(result.current.serverPanelCollapsed).toBe(true)

    // Toggle a server visible
    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })

    // Panel should be expanded now
    expect(result.current.serverPanelCollapsed).toBe(false)
  })

  it("handleToggleServer does not duplicate in serverMap if already present", () => {
    const { result } = renderHook(() => useServerPanel("session-1"))

    act(() => {
      result.current.handleServersChanged([
        { id: "s1", outputPath: "/out/s1", title: "Server 1" },
      ])
    })

    const mapRef = result.current.serverMap

    // Toggle with outputPath/title - should not create new map since s1 already exists
    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })

    expect(result.current.serverMap).toBe(mapRef)
  })

  it("saves and restores state when switching sessions", () => {
    const { result, rerender } = renderHook(
      (props: { sessionId: string | null }) => useServerPanel(props.sessionId),
      { initialProps: { sessionId: "session-A" } }
    )

    // Set up some state for session A
    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })
    act(() => {
      result.current.handleToggleServerCollapse()
    })

    expect(result.current.visibleServerIds.has("s1")).toBe(true)
    expect(result.current.serverPanelCollapsed).toBe(true)

    // Switch to session B
    rerender({ sessionId: "session-B" })

    // Session B should have clean state
    expect(result.current.visibleServerIds.size).toBe(0)
    expect(result.current.serverPanelCollapsed).toBe(false)

    // Set up state for session B
    act(() => {
      result.current.handleToggleServer("s2", "/out/s2", "Server 2")
    })

    // Switch back to session A
    rerender({ sessionId: "session-A" })

    // Session A state should be restored
    expect(result.current.visibleServerIds.has("s1")).toBe(true)
    expect(result.current.serverPanelCollapsed).toBe(true)
  })

  it("resets state when switching to null session", () => {
    const { result, rerender } = renderHook(
      (props: { sessionId: string | null }) => useServerPanel(props.sessionId),
      { initialProps: { sessionId: "session-A" } }
    )

    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })

    rerender({ sessionId: null })

    expect(result.current.visibleServerIds.size).toBe(0)
    expect(result.current.serverPanelCollapsed).toBe(false)
  })

  it("does not save state if prevSessionId was null", () => {
    const { result, rerender } = renderHook(
      (props: { sessionId: string | null }) => useServerPanel(props.sessionId),
      { initialProps: { sessionId: null as string | null } }
    )

    // Switch from null to a session
    rerender({ sessionId: "session-A" })

    // Should start with clean state (no saved state from null)
    expect(result.current.visibleServerIds.size).toBe(0)
    expect(result.current.serverPanelCollapsed).toBe(false)
  })

  it("handleServersChanged does not clean visibleIds when servers list is empty", () => {
    const { result } = renderHook(() => useServerPanel("session-1"))

    // Add a server and make it visible
    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })

    expect(result.current.visibleServerIds.has("s1")).toBe(true)

    // Pass empty list - should NOT clean up visible IDs (the code only cleans when servers.length > 0)
    act(() => {
      result.current.handleServersChanged([])
    })

    expect(result.current.visibleServerIds.has("s1")).toBe(true)
  })

  it("handleServersChanged keeps visibleIds reference when no cleanup needed", () => {
    const { result } = renderHook(() => useServerPanel("session-1"))

    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })

    const visibleRef = result.current.visibleServerIds

    // Update servers but keep s1
    act(() => {
      result.current.handleServersChanged([
        { id: "s1", outputPath: "/out/s1", title: "Server 1" },
        { id: "s2", outputPath: "/out/s2", title: "Server 2" },
      ])
    })

    // visibleIds should be same reference since all visible IDs still exist
    expect(result.current.visibleServerIds).toBe(visibleRef)
  })
})
