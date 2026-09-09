import { useCallback, useState } from "react"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
  jsonFetch: vi.fn(),
}))

vi.mock("@/lib/device", () => ({
  isRemoteDeviceActive: vi.fn(() => false),
}))

import { useProjectWorkspace } from "@/hooks/useProjectWorkspace"
import { authFetch, jsonFetch } from "@/lib/auth"
import { isRemoteDeviceActive } from "@/lib/device"
import {
  __resetFileOpenerForTest,
  openFile,
  openProject,
  setBuiltInEditorEnabled,
} from "@/lib/fileOpener"

const mockAuthFetch = vi.mocked(authFetch)
const mockJsonFetch = vi.mocked(jsonFetch)
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

function useTestWorkspace(options: typeof baseOptions) {
  const [activeWorkspacePanel, setActiveWorkspacePanel] = useState<string | null>(null)
  const closeWorkspacePanel = useCallback(() => setActiveWorkspacePanel(null), [])
  return useProjectWorkspace({
    ...options,
    activeWorkspacePanel,
    openWorkspacePanel: setActiveWorkspacePanel,
    closeWorkspacePanel,
  })
}

describe("useProjectWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRemoteDeviceActive.mockReturnValue(false)
    mockAuthFetch.mockResolvedValue(new Response(null, { status: 200 }))
    mockJsonFetch.mockResolvedValue(new Response(null, { status: 200 }))
  })

  afterEach(() => __resetFileOpenerForTest())

  it("opens a native terminal with the authoritative session path and project", () => {
    const { result } = renderHook(() => useTestWorkspace(baseOptions))

    act(() => result.current.handleOpenTerminal())

    expect(mockAuthFetch).toHaveBeenCalledOnce()
    expect(mockAuthFetch).toHaveBeenCalledWith("/api/open-terminal", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ path: "/repo", dirName: "-repo" }),
    }))
  })

  it("keeps native terminal and MCP auth actions local-only", () => {
    mockIsRemoteDeviceActive.mockReturnValue(true)
    const { result } = renderHook(() => useTestWorkspace(baseOptions))

    act(() => {
      result.current.handleOpenTerminal()
      result.current.handleMcpAuth("github")
    })

    expect(mockAuthFetch).not.toHaveBeenCalled()
  })

  it("launches MCP authentication in the resolved project", () => {
    const { result } = renderHook(() => useTestWorkspace({
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
    const { result } = renderHook(() => useTestWorkspace({
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
    const { result } = renderHook(() => useTestWorkspace(baseOptions))

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
    const { result } = renderHook(() => useTestWorkspace({
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

  it("keeps preview and workspace panels mutually exclusive across projects", () => {
    const { result, rerender } = renderHook(
      (options: typeof baseOptions) => useTestWorkspace(options),
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
    expect(result.current.showProjectFiles).toBe(true)

    act(() => result.current.handleTogglePreview())
    expect(result.current.showPreview).toBe(true)
    act(() => result.current.closeRightWorkspace())
    expect(result.current.showPreview).toBe(false)
  })

  describe("built-in file workspace", () => {
    it("opens a project file in place, without touching the host editor", () => {
      const { result } = renderHook(() => useTestWorkspace(baseOptions))
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
      expect(mockJsonFetch).not.toHaveBeenCalled()
    })

    it("opens a git diff in the workspace", () => {
      const { result } = renderHook(() => useTestWorkspace(baseOptions))
      setBuiltInEditorEnabled(true)

      act(() => openFile("/repo/src/app.ts", { mode: "diff" }))

      expect(result.current.projectFilesRequest).toMatchObject({
        file: "src/app.ts",
        mode: "diff",
      })
    })

    it("issues a fresh token for every request so repeat opens still apply", () => {
      const { result } = renderHook(() => useTestWorkspace(baseOptions))
      setBuiltInEditorEnabled(true)

      act(() => openFile("/repo/src/app.ts"))
      act(() => openFile("/repo/src/app.ts"))

      expect(result.current.projectFilesRequest?.token).toBe(2)
    })

    it("browses the containing directory for files outside the project", () => {
      const { result } = renderHook(() => useTestWorkspace(baseOptions))
      setBuiltInEditorEnabled(true)

      act(() => openFile("/home/me/.claude/skills/commit/SKILL.md"))

      expect(result.current.projectFilesRoot).toBe("/home/me/.claude/skills/commit")
      expect(result.current.projectFilesRequest).toMatchObject({ file: "SKILL.md" })
      expect(result.current.showProjectFiles).toBe(true)
    })

    it("opens a project with no file selected", () => {
      const { result } = renderHook(() => useTestWorkspace(baseOptions))
      setBuiltInEditorEnabled(true)

      act(() => openProject({ path: "/repo", dirName: "-repo" }))

      expect(result.current.projectFilesRoot).toBe("/repo")
      expect(result.current.projectFilesRequest).toBeNull()
    })

    it("keeps the workspace selected while repointing it to another project", () => {
      const { result, rerender } = renderHook(
        (options: typeof baseOptions) => useTestWorkspace(options),
        { initialProps: baseOptions },
      )
      setBuiltInEditorEnabled(true)

      act(() => openFile("/repo/src/app.ts"))
      expect(result.current.showProjectFiles).toBe(true)

      rerender({ ...baseOptions, sessionCwd: "/other-repo" })
      expect(result.current.showProjectFiles).toBe(true)
      expect(result.current.projectFilesRoot).toBeUndefined()
    })

    it("defers to the host editor in shells without a file workspace", () => {
      const { result } = renderHook(() => useTestWorkspace({
        ...baseOptions,
        supportsFileWorkspace: false,
      }))
      setBuiltInEditorEnabled(true)

      act(() => openFile("/repo/src/app.ts"))

      expect(result.current.showProjectFiles).toBe(false)
      expect(mockJsonFetch).toHaveBeenCalledWith(
        "/api/open-in-editor",
        expect.objectContaining({ path: "/repo/src/app.ts", mode: "file" }),
      )
    })
  })
})
