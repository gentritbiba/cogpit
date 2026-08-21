import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

vi.mock("@/lib/device", () => ({
  isRemoteDeviceActive: vi.fn(() => false),
}))

import { useProjectWorkspace } from "@/hooks/useProjectWorkspace"
import { authFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"
import {
  __resetFileOpenerForTest,
  openFile,
  openProject,
  setBuiltInEditorEnabled,
} from "@/lib/fileOpener"

const mockAuthFetch = vi.mocked(authFetch)
const mockIsRemoteDeviceActive = vi.mocked(isRemoteDeviceActive)

const baseOptions = {
  sessionId: "session-1" as string | null,
  sessionCwd: "/repo" as string | null,
  pendingPath: null as string | null,
  sessionDirName: "-repo" as string | null,
  pendingDirName: null as string | null,
  dashboardProject: null as string | null,
  supportsFileWorkspace: true,
}

describe("useProjectWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRemoteDeviceActive.mockReturnValue(false)
    mockAuthFetch.mockResolvedValue(new Response(null, { status: 200 }))
  })

  afterEach(() => __resetFileOpenerForTest())

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

  it("exposes the pending project without borrowing active-session state", () => {
    const { result } = renderHook(() => useProjectWorkspace({
      ...baseOptions,
      sessionCwd: null,
      sessionDirName: null,
      pendingPath: "/pending/repo",
      pendingDirName: "-pending-repo",
    }))

    expect(result.current.pendingProject).toEqual({
      path: "/pending/repo",
      dirName: "-pending-repo",
    })
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

  describe("built-in file workspace", () => {
    it("opens a project file in place, without touching the host editor", () => {
      const { result } = renderHook(() => useProjectWorkspace(baseOptions))
      setBuiltInEditorEnabled(true)

      act(() => openFile("/repo/src/app.ts", { line: 12 }))

      expect(result.current.showProjectFiles).toBe(true)
      expect(result.current.projectFilesRoot).toBe("/repo")
      expect(result.current.projectFilesRequest).toEqual({
        file: "src/app.ts",
        mode: "edit",
        line: 12,
        token: 1,
      })
      expect(mockAuthFetch).not.toHaveBeenCalled()
    })

    it("opens a git diff in the workspace", () => {
      const { result } = renderHook(() => useProjectWorkspace(baseOptions))
      setBuiltInEditorEnabled(true)

      act(() => openFile("/repo/src/app.ts", { mode: "diff" }))

      expect(result.current.projectFilesRequest).toMatchObject({
        file: "src/app.ts",
        mode: "diff",
      })
    })

    it("issues a fresh token for every request so repeat opens still apply", () => {
      const { result } = renderHook(() => useProjectWorkspace(baseOptions))
      setBuiltInEditorEnabled(true)

      act(() => openFile("/repo/src/app.ts"))
      act(() => openFile("/repo/src/app.ts"))

      expect(result.current.projectFilesRequest?.token).toBe(2)
    })

    it("browses the containing directory for files outside the project", () => {
      const { result } = renderHook(() => useProjectWorkspace(baseOptions))
      setBuiltInEditorEnabled(true)

      act(() => openFile("/home/me/.claude/skills/commit/SKILL.md"))

      expect(result.current.projectFilesRoot).toBe("/home/me/.claude/skills/commit")
      expect(result.current.projectFilesRequest).toMatchObject({ file: "SKILL.md" })
      // Anchored to the active project, so switching sessions hides it.
      expect(result.current.showProjectFiles).toBe(true)
    })

    it("opens a project with no file selected", () => {
      const { result } = renderHook(() => useProjectWorkspace(baseOptions))
      setBuiltInEditorEnabled(true)

      act(() => openProject({ path: "/repo", dirName: "-repo" }))

      expect(result.current.projectFilesRoot).toBe("/repo")
      expect(result.current.projectFilesRequest).toBeNull()
    })

    it("hides the workspace once another project becomes active", () => {
      const { result, rerender } = renderHook(
        (options: typeof baseOptions) => useProjectWorkspace(options),
        { initialProps: baseOptions },
      )
      setBuiltInEditorEnabled(true)

      act(() => openFile("/repo/src/app.ts"))
      expect(result.current.showProjectFiles).toBe(true)

      rerender({ ...baseOptions, sessionCwd: "/other-repo" })
      expect(result.current.showProjectFiles).toBe(false)
      expect(result.current.projectFilesRoot).toBeUndefined()
    })

    it("defers to the host editor in shells without a file workspace", () => {
      const { result } = renderHook(() => useProjectWorkspace({
        ...baseOptions,
        supportsFileWorkspace: false,
      }))
      setBuiltInEditorEnabled(true)

      act(() => openFile("/repo/src/app.ts"))

      expect(result.current.showProjectFiles).toBe(false)
      expect(mockAuthFetch).toHaveBeenCalledWith("/api/open-in-editor", expect.objectContaining({
        body: JSON.stringify({ path: "/repo/src/app.ts", mode: "file" }),
      }))
    })
  })
})
