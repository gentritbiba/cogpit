import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_PERMISSIONS } from "@/lib/permissions"
import { encodeCodexDirName, type AgentKind } from "@/lib/sessionSource"
import type { SessionAction } from "@/hooks/useSessionState"

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn(),
}))

import { useProjectSessionLaunch } from "@/hooks/useProjectSessionLaunch"
import { authFetch } from "@/lib/auth"

const mockAuthFetch = vi.mocked(authFetch)
const dispatch = vi.fn<(action: SessionAction) => void>()
const onCodexModelRejected = vi.fn<(model: string) => void>()

const baseOptions = {
  permissionsConfig: DEFAULT_PERMISSIONS,
  dispatch,
  isMobile: false,
  defaultAgentKind: "claude" as AgentKind,
  pendingDirName: null as string | null,
  pendingCwd: null as string | null,
  model: "",
  effort: "high",
  fastMode: false,
  ultracode: false,
  mcpConfig: null as string | null,
  onCodexModelRejected,
}

describe("useProjectSessionLaunch", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("starts a Claude project immediately and can switch the pending project to Codex", async () => {
    const { result } = renderHook(() => useProjectSessionLaunch(baseOptions))

    await act(async () => result.current.handleStartNewSession("-repo", "/repo"))

    expect(mockAuthFetch).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "INIT_PENDING_SESSION",
      dirName: "-repo",
      cwd: "/repo",
      isMobile: false,
    })
    expect(result.current.pendingAgentKindChange).toEqual(expect.any(Function))

    act(() => result.current.pendingAgentKindChange?.("codex"))
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "INIT_PENDING_SESSION",
      dirName: encodeCodexDirName("/repo"),
      cwd: "/repo",
      isMobile: false,
    })
  })

  it("normalizes a stale Claude dirName to the supplied cwd", async () => {
    const { result } = renderHook(() => useProjectSessionLaunch(baseOptions))

    await act(async () => result.current.handleStartNewSession(
      "-repo--claude-worktrees-feature",
      "/repo",
    ))

    expect(mockAuthFetch).not.toHaveBeenCalled()
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "INIT_PENDING_SESSION",
      dirName: "-repo",
      cwd: "/repo",
      isMobile: false,
    })
  })

  it("resolves the Claude peer before starting a Codex project", async () => {
    mockAuthFetch.mockResolvedValue(new Response(JSON.stringify([
      { dirName: encodeCodexDirName("/repo"), path: "/repo" },
      { dirName: "-repo", path: "/repo/" },
    ]), { status: 200 }))
    const { result } = renderHook(() => useProjectSessionLaunch(baseOptions))

    await act(async () => result.current.handleStartNewSession(encodeCodexDirName("/repo"), "/repo"))

    expect(mockAuthFetch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "INIT_PENDING_SESSION",
      dirName: encodeCodexDirName("/repo"),
      cwd: "/repo",
      isMobile: false,
    })

    act(() => result.current.pendingAgentKindChange?.("claude"))
    expect(dispatch).toHaveBeenLastCalledWith({
      type: "INIT_PENDING_SESSION",
      dirName: "-repo",
      cwd: "/repo",
      isMobile: false,
    })
  })

  it("caches project resolution by cwd", async () => {
    mockAuthFetch.mockResolvedValue(new Response(JSON.stringify([
      { dirName: "-repo", path: "/repo" },
    ]), { status: 200 }))
    const { result } = renderHook(() => useProjectSessionLaunch(baseOptions))
    const codexDirName = encodeCodexDirName("/repo")

    await act(async () => result.current.handleStartNewSession(codexDirName, "/repo"))
    await act(async () => result.current.handleStartNewSession(codexDirName, "/repo"))

    expect(mockAuthFetch).toHaveBeenCalledOnce()
  })

  it("still starts Codex when no matching Claude project exists", async () => {
    mockAuthFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    const { result } = renderHook(() => useProjectSessionLaunch(baseOptions))
    const codexDirName = encodeCodexDirName("/new-repo")

    await act(async () => result.current.handleStartNewSession(codexDirName, "/new-repo"))

    expect(dispatch).toHaveBeenLastCalledWith({
      type: "INIT_PENDING_SESSION",
      dirName: codexDirName,
      cwd: "/new-repo",
      isMobile: false,
    })
    expect(result.current.pendingAgentKindChange).toBeUndefined()
  })

  it("uses the configured provider for a newly selected folder", async () => {
    mockAuthFetch.mockResolvedValue(new Response(JSON.stringify([
      { dirName: "-new-repo", path: "/new/repo" },
    ]), { status: 200 }))
    const { result } = renderHook(() => useProjectSessionLaunch({
      ...baseOptions,
      defaultAgentKind: "codex",
      isMobile: true,
    }))

    act(() => result.current.handleStartNewFolder("/new/repo"))

    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({
      type: "INIT_PENDING_SESSION",
      dirName: encodeCodexDirName("/new/repo"),
      cwd: "/new/repo",
      isMobile: true,
    }))
  })

  it("keeps launch callbacks and bridge refs stable across runtime-setting changes", () => {
    const { result, rerender } = renderHook(
      (options: typeof baseOptions) => useProjectSessionLaunch(options),
      { initialProps: baseOptions },
    )
    const startSession = result.current.handleStartNewSession
    const finalizedRef = result.current.sessionFinalizedRef
    const refreshRef = result.current.liveSessionsRefreshRef

    rerender({ ...baseOptions, model: "opus", effort: "xhigh" })

    expect(result.current.handleStartNewSession).toBe(startSession)
    expect(result.current.sessionFinalizedRef).toBe(finalizedRef)
    expect(result.current.liveSessionsRefreshRef).toBe(refreshRef)
  })
})
