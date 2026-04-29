import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useProcessPanel } from "../useProcessPanel"
import type { ProcessEntry } from "../useProcessPanel"

describe("useProcessPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns initial state with empty map", () => {
    const { result } = renderHook(() => useProcessPanel(null))
    expect(result.current.processes.size).toBe(0)
    expect(result.current.activeProcessId).toBe(null)
    expect(result.current.collapsed).toBe(true)
    expect(typeof result.current.toggleCollapse).toBe("function")
    expect(typeof result.current.addProcess).toBe("function")
    expect(typeof result.current.removeProcess).toBe("function")
    expect(typeof result.current.handleServersChanged).toBe("function")
    expect(typeof result.current.handleToggleServer).toBe("function")
  })

  it("toggleCollapse toggles collapsed state", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    expect(result.current.collapsed).toBe(true)

    act(() => {
      result.current.toggleCollapse()
    })
    expect(result.current.collapsed).toBe(false)

    act(() => {
      result.current.toggleCollapse()
    })
    expect(result.current.collapsed).toBe(true)
  })

  it("addProcess adds entry, sets it active, and uncollapses", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    const entry: ProcessEntry = {
      id: "proc_1",
      name: "dev",
      type: "script",
      status: "running",
    }

    act(() => {
      result.current.addProcess(entry)
    })

    expect(result.current.processes.size).toBe(1)
    expect(result.current.processes.get("proc_1")).toEqual(entry)
    expect(result.current.activeProcessId).toBe("proc_1")
    expect(result.current.collapsed).toBe(false)
  })

  it("removeProcess removes entry and switches active to remaining", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    act(() => {
      result.current.addProcess({ id: "p1", name: "dev", type: "script", status: "running" })
    })
    act(() => {
      result.current.addProcess({ id: "p2", name: "build", type: "script", status: "running" })
    })

    expect(result.current.activeProcessId).toBe("p2")

    act(() => {
      result.current.removeProcess("p2")
    })

    expect(result.current.processes.size).toBe(1)
    expect(result.current.processes.has("p2")).toBe(false)
  })

  it("setActive changes active process and uncollapses", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    act(() => {
      result.current.addProcess({ id: "p1", name: "dev", type: "script", status: "running" })
    })
    act(() => {
      result.current.addProcess({ id: "p2", name: "build", type: "script", status: "running" })
    })

    // Collapse first
    act(() => {
      result.current.toggleCollapse()
    })
    expect(result.current.collapsed).toBe(true)

    act(() => {
      result.current.setActive("p1")
    })

    expect(result.current.activeProcessId).toBe("p1")
    expect(result.current.collapsed).toBe(false)
  })

  it("updateProcessStatus updates a process status", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    act(() => {
      result.current.addProcess({ id: "p1", name: "dev", type: "script", status: "running" })
    })

    act(() => {
      result.current.updateProcessStatus("p1", "stopped")
    })

    expect(result.current.processes.get("p1")?.status).toBe("stopped")
  })

  it("handleServersChanged adds task entries", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    act(() => {
      result.current.handleServersChanged([
        { id: "s1", outputPath: "/out/s1", title: "Server 1" },
        { id: "s2", outputPath: "/out/s2", title: "Server 2" },
      ])
    })

    expect(result.current.processes.size).toBe(2)
    const s1 = result.current.processes.get("s1")
    expect(s1?.type).toBe("task")
    expect(s1?.name).toBe("Server 1")
    expect(s1?.outputPath).toBe("/out/s1")
  })

  it("handleServersChanged removes old task entries not in new list", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    act(() => {
      result.current.handleServersChanged([
        { id: "s1", outputPath: "/out/s1", title: "Server 1" },
        { id: "s2", outputPath: "/out/s2", title: "Server 2" },
      ])
    })

    act(() => {
      result.current.handleServersChanged([
        { id: "s1", outputPath: "/out/s1", title: "Server 1" },
      ])
    })

    expect(result.current.processes.size).toBe(1)
    expect(result.current.processes.has("s2")).toBe(false)
  })

  it("handleServersChanged does not remove script entries", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    act(() => {
      result.current.addProcess({ id: "p1", name: "dev", type: "script", status: "running" })
    })

    act(() => {
      result.current.handleServersChanged([
        { id: "s1", outputPath: "/out/s1", title: "Server 1" },
      ])
    })

    expect(result.current.processes.size).toBe(2)
    expect(result.current.processes.has("p1")).toBe(true)
    expect(result.current.processes.has("s1")).toBe(true)
  })

  it("handleServersChanged does not trigger update when data is identical", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    const servers = [{ id: "s1", outputPath: "/out/s1", title: "Server 1" }]

    act(() => {
      result.current.handleServersChanged(servers)
    })

    const mapRef = result.current.processes

    act(() => {
      result.current.handleServersChanged([...servers])
    })

    expect(result.current.processes).toBe(mapRef)
  })

  it("handleToggleServer adds a task entry and sets it active", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })

    expect(result.current.processes.has("s1")).toBe(true)
    expect(result.current.processes.get("s1")?.type).toBe("task")
    expect(result.current.activeProcessId).toBe("s1")
    expect(result.current.collapsed).toBe(false)
  })

  it("handleToggleServer collapses when toggling already-active process", () => {
    const { result } = renderHook(() => useProcessPanel("session-1"))

    act(() => {
      result.current.handleToggleServer("s1", "/out/s1", "Server 1")
    })

    expect(result.current.collapsed).toBe(false)

    act(() => {
      result.current.handleToggleServer("s1")
    })

    expect(result.current.collapsed).toBe(true)
  })

  it("saves and restores state when switching sessions", () => {
    const { result, rerender } = renderHook(
      (props: { sessionId: string | null }) => useProcessPanel(props.sessionId),
      { initialProps: { sessionId: "session-A" } }
    )

    act(() => {
      result.current.addProcess({ id: "p1", name: "dev", type: "script", status: "running" })
    })

    expect(result.current.activeProcessId).toBe("p1")
    expect(result.current.collapsed).toBe(false)

    // Switch to session B
    rerender({ sessionId: "session-B" })

    expect(result.current.activeProcessId).toBe(null)
    expect(result.current.collapsed).toBe(true)

    // Switch back to session A
    rerender({ sessionId: "session-A" })

    expect(result.current.activeProcessId).toBe("p1")
    expect(result.current.collapsed).toBe(false)
  })

  it("resets state when switching to null session", () => {
    const { result, rerender } = renderHook(
      (props: { sessionId: string | null }) => useProcessPanel(props.sessionId),
      { initialProps: { sessionId: "session-A" } }
    )

    act(() => {
      result.current.addProcess({ id: "p1", name: "dev", type: "script", status: "running" })
    })

    rerender({ sessionId: null })

    expect(result.current.activeProcessId).toBe(null)
    expect(result.current.collapsed).toBe(true)
  })

  it("does not save state if prevSessionId was null", () => {
    const { result, rerender } = renderHook(
      (props: { sessionId: string | null }) => useProcessPanel(props.sessionId),
      { initialProps: { sessionId: null as string | null } }
    )

    rerender({ sessionId: "session-A" })

    expect(result.current.activeProcessId).toBe(null)
    expect(result.current.collapsed).toBe(true)
  })
})
