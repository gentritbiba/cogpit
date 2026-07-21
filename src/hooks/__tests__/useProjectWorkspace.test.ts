import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

vi.mock("@/lib/device", () => ({
  isRemoteDeviceActive: vi.fn(() => false),
}))

import { useProjectWorkspace } from "@/hooks/useProjectWorkspace"
import { authFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"

const mockAuthFetch = vi.mocked(authFetch)
const mockIsRemoteDeviceActive = vi.mocked(isRemoteDeviceActive)

const baseOptions = {
  sessionId: "session-1" as string | null,
  sessionCwd: "/repo" as string | null,
  pendingPath: null as string | null,
  sessionDirName: "-repo" as string | null,
  pendingDirName: null as string | null,
  dashboardProject: null as string | null,
}

describe("useProjectWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRemoteDeviceActive.mockReturnValue(false)
    mockAuthFetch.mockResolvedValue(new Response(null, { status: 200 }))
  })

  it("opens a native terminal with the authoritative session path and project", () => {
    const { result } = renderHook(() => useProjectWorkspace(baseOptions))

    act(() => result.current.handleOpenTerminal())

    expect(mockAuthFetch).toHaveBeenCalledOnce()
    expect(mockAuthFetch).toHaveBeenCalledWith("/api/open-terminal", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ path: "/repo", dirName: "-repo" }),
    }))
  })

  it("keeps native terminal and MCP auth actions local-only", () => {
    mockIsRemoteDeviceActive.mockReturnValue(true)
    const { result } = renderHook(() => useProjectWorkspace(baseOptions))

    act(() => {
      result.current.handleOpenTerminal()
      result.current.handleMcpAuth("github")
    })

    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("launches MCP authentication in the resolved project", () => {
    const { result } = renderHook(() => useProjectWorkspace({
      ...baseOptions,
      sessionCwd: null,
      sessionDirName: null,
      pendingPath: "/pending/repo",
      pendingDirName: "-pending-repo",
    }))

    act(() => result.current.handleMcpAuth("github"))

    expect(mockAuthFetch).toHaveBeenCalledWith("/api/open-terminal", expect.objectContaining({
      body: JSON.stringify({
        path: "/pending/repo",
        dirName: "-pending-repo",
        command: "claude /mcp",
      }),
    }))
  })

  it("posts pending-project editor actions without borrowing active-session state", () => {
    const { result } = renderHook(() => useProjectWorkspace({
      ...baseOptions,
      sessionCwd: null,
      sessionDirName: null,
      pendingPath: "/pending/repo",
      pendingDirName: "-pending-repo",
    }))

    act(() => result.current.postProjectAction("/api/open-in-editor"))

    expect(mockAuthFetch).toHaveBeenCalledWith("/api/open-in-editor", expect.objectContaining({
      body: JSON.stringify({ path: "/pending/repo", dirName: "-pending-repo" }),
    }))
  })

  it("requests a terminal when none exists, then toggles the latest terminal", () => {
    const { result } = renderHook(() => useProjectWorkspace(baseOptions))

    act(() => result.current.handleToggleIntegratedTerminal())
    expect(result.current.launchTerminalRequest).toBe(1)

    act(() => {
      result.current.processPanel.addProcess({
        id: "terminal-1",
        name: "Terminal",
        type: "terminal",
        status: "running",
      })
    })
    expect(result.current.processPanel.collapsed).toBe(false)

    act(() => result.current.handleToggleIntegratedTerminal())
    expect(result.current.processPanel.collapsed).toBe(true)

    act(() => result.current.handleToggleIntegratedTerminal())
    expect(result.current.processPanel.collapsed).toBe(false)
    expect(result.current.processPanel.activeProcessId).toBe("terminal-1")
  })

  it("does not request an integrated terminal without a real cwd", () => {
    const { result } = renderHook(() => useProjectWorkspace({
      ...baseOptions,
      sessionCwd: null,
      pendingPath: null,
    }))

    act(() => {
      result.current.handleToggleIntegratedTerminal()
      result.current.handleNewIntegratedTerminal()
    })

    expect(result.current.launchTerminalRequest).toBe(0)
  })

  it("scopes preview and project-files panes to the current cwd", () => {
    const { result, rerender } = renderHook(
      (options: typeof baseOptions) => useProjectWorkspace(options),
      { initialProps: baseOptions },
    )

    act(() => result.current.handleTogglePreview())
    expect(result.current.showPreview).toBe(true)
    expect(result.current.showProjectFiles).toBe(false)

    act(() => result.current.handleToggleProjectFiles())
    expect(result.current.showPreview).toBe(false)
    expect(result.current.showProjectFiles).toBe(true)

    rerender({ ...baseOptions, sessionCwd: "/other-repo" })
    expect(result.current.showPreview).toBe(false)
    expect(result.current.showProjectFiles).toBe(false)

    act(() => result.current.handleTogglePreview())
    expect(result.current.showPreview).toBe(true)
    act(() => result.current.closeRightWorkspace())
    expect(result.current.showPreview).toBe(false)
  })
})
