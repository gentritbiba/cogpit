import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useNewSession } from "../useNewSession"
import type { PermissionsConfig } from "@/lib/permissions"
import { EMPTY_SESSION_DIGEST, type SessionView } from "../../../shared/session/sessionDigest"
import { ALL_CAPABILITIES, NO_CAPABILITIES } from "../../../shared/contracts/identity"
import type { ListedAccess } from "../../../shared/contracts/sessionAccess"
import { __resetCapabilitiesForTest, setMe } from "@/lib/capabilities"

// Mock authFetch
vi.mock("@/lib/auth", async (importOriginal) => ({
  AuthRequiredError: (await importOriginal<typeof import("@/lib/auth")>()).AuthRequiredError,
  authFetch: vi.fn(),
}))

vi.mock("@/hooks/useSessionNames", () => ({
  rename: vi.fn(),
}))

import { authFetch } from "@/lib/auth"
import type { LoadedSession, SessionAddress, SessionController } from "@/lib/sessionLoader"
import { __resetSessionAccessForTest, knownSessionAccess } from "@/lib/sessionAccess"
import { rename as renameSession } from "@/hooks/useSessionNames"
import { registerCodeModeRunner, setCodeModeEnabled, type CodeModeRunner } from "@/lib/agents/codeMode"
import { AuthRequiredError } from "@/lib/auth"
import { createPaneLifetime, PaneLifetimeProvider } from "@/contexts/DevicePaneContext"
import { createElement, type ReactNode } from "react"

const mockedAuthFetch = vi.mocked(authFetch)

const mockSession: SessionView = {
  sessionId: "new-session-1",
  version: "1",
  gitBranch: "main",
  cwd: "/tmp",
  slug: "test",
  name: "",
  model: "opus",
  turns: [],
  stats: {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    toolCallCounts: {},
    errorCount: 0,
    totalDurationMs: 0,
    turnCount: 0,
  },
  digest: EMPTY_SESSION_DIGEST,
}

/** The tail load an open ends in; the controller's own behaviour has its own suite. */
const load = vi.fn<(address: SessionAddress) => Promise<LoadedSession>>()

const sessions: SessionController = {
  openSession: vi.fn(),
  prefetchSession: vi.fn(),
  reloadCurrent: vi.fn(),
  leave: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
  showing: vi.fn(() => null),
}

describe("useNewSession", () => {
  const dispatch = vi.fn()
  const onSessionFinalized = vi.fn()
  const permissionsConfig: PermissionsConfig = { mode: "default" } as PermissionsConfig

  const defaultOpts = {
    permissionsConfig,
    dispatch,
    sessions,
    isMobile: false,
    onSessionFinalized,
    model: "claude-opus-4-6",
    effort: "high",
  }

  beforeEach(() => {
    vi.resetAllMocks()
    load.mockImplementation(async (address) => ({
      parsed: mockSession,
      source: { ...address, watchOffset: 64, loadId: 7 },
    }))
    vi.mocked(sessions.openSession).mockImplementation(async (target, { commit, recover }) => {
      const address = typeof target === "function" ? await target(new AbortController().signal) : target
      let loaded: LoadedSession
      try {
        loaded = await load(address)
      } catch (error) {
        if (!recover) throw error
        loaded = recover(error, address)
      }
      commit(loaded)
      return "opened"
    })
  })

  it("returns initial state", () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))
    expect(result.current.creatingSession).toBe(false)
    expect(result.current.createError).toBeNull()
    expect(typeof result.current.handleNewSession).toBe("function")
    expect(typeof result.current.createAndSend).toBe("function")
    expect(typeof result.current.clearCreateError).toBe("function")
  })

  it("handleNewSession dispatches INIT_PENDING_SESSION", () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("my-dir")
    })

    expect(dispatch).toHaveBeenCalledWith({
      type: "INIT_PENDING_SESSION",
      dirName: "my-dir",
      isMobile: false,
    })
    expect(result.current.creatingSession).toBe(false)
    expect(result.current.createError).toBeNull()
  })

  it("handleNewSession clears previous error", () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    // First force an error state via a failed createAndSend
    act(() => {
      result.current.handleNewSession("dir1")
    })

    // createError should be null after handleNewSession
    expect(result.current.createError).toBeNull()
  })

  it("createAndSend returns null when no pending dirName", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    let sessionId: string | null = null
    await act(async () => {
      sessionId = await result.current.createAndSend("hello")
    })

    expect(sessionId).toBeNull()
    expect(mockedAuthFetch).not.toHaveBeenCalled()
  })

  it("createAndSend preserves cwd and context limit and promotes immediately", async () => {
    const onCreated = vi.fn()
    const { result } = renderHook(() => useNewSession({ ...defaultOpts, contextWindowTokens: 1000000 }))

    // Set up the pending dirName
    act(() => {
      result.current.handleNewSession("-tmp-my-project", "/tmp/my-project")
    })

    // Mock the create-and-send response
    mockedAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          dirName: "-tmp-my-project",
          fileName: "session.jsonl",
          sessionId: "session-123",
        }),
      } as Response)

    let sessionId: string | null = null
    await act(async () => {
      sessionId = await result.current.createAndSend("hello", undefined, onCreated)
    })

    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ sessionId: expect.any(String), cwd: expect.any(String), dirName: expect.any(String) }))
    expect(sessionId).toBe("session-123")
    const body = JSON.parse((mockedAuthFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.cwd).toBe("/tmp/my-project")
    expect(body.contextWindowTokens).toBe(1000000)
    expect(result.current.creatingSession).toBe(false)
    // Finalized from a tail load through the controller, never by fetching and parsing the whole file here.
    expect(sessions.openSession).toHaveBeenCalledWith(
      { dirName: "-tmp-my-project", fileName: "session.jsonl" },
      expect.objectContaining({ reason: "finalize" }),
    )
    expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({
      type: "FINALIZE_SESSION",
      session: mockSession,
      source: { dirName: "-tmp-my-project", fileName: "session.jsonl", watchOffset: 64, loadId: 7 },
      isMobile: false,
    })
    expect(onSessionFinalized).toHaveBeenCalledWith(
      mockSession,
      expect.objectContaining({ dirName: "-tmp-my-project", fileName: "session.jsonl" })
    )
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "RELOAD_SESSION_CONTENT" }))
  })

  it("owns a session it just created in team edition before showing it", async () => {
    const alice = { id: "u_alice", username: "alice", displayName: "Alice" }
    setMe({
      authenticated: true,
      edition: "team",
      user: { ...alice },
      capabilities: NO_CAPABILITIES,
      enforcesSessionAccess: true,
    })
    const accessWhenShown = vi.fn()
    dispatch.mockImplementation((action: { type: string }) => {
      if (action.type === "FINALIZE_SESSION") accessWhenShown(knownSessionAccess("session-123"))
    })
    const { result } = renderHook(() => useNewSession(defaultOpts))
    act(() => {
      result.current.handleNewSession("-tmp-my-project", "/tmp/my-project")
    })
    mockedAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dirName: "-tmp-my-project", fileName: "session.jsonl", sessionId: "session-123" }),
      } as Response)

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    expect(accessWhenShown).toHaveBeenCalledWith("own")
    __resetCapabilitiesForTest()
    __resetSessionAccessForTest()
  })

  it("createAndSend sets error on failed create response", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    mockedAuthFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Internal server error" }),
    } as Response)

    let sessionId: string | null = null
    await act(async () => {
      sessionId = await result.current.createAndSend("hello")
    })

    expect(sessionId).toBeNull()
    expect(result.current.createError).toBe("Internal server error")
    expect(result.current.creatingSession).toBe(false)
  })

  it("retries Codex session creation without a rejected model override", async () => {
    const onModelRejected = vi.fn()
    const { result } = renderHook(() =>
      useNewSession({
        ...defaultOpts,
        model: "gpt-5.4-mini",
        onModelRejected,
      })
    )

    act(() => {
      result.current.handleNewSession("codex__test")
    })

    mockedAuthFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({
          error: "There's an issue with the selected model (gpt-5.4-mini). It may not exist or you may not have access to it. Run --model to pick a different model.",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          dirName: "codex__test",
          fileName: "session.jsonl",
          sessionId: "session-123",
        }),
      } as Response)

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    expect(onModelRejected).toHaveBeenCalledWith("gpt-5.4-mini")

    const firstBody = JSON.parse((mockedAuthFetch.mock.calls[0][1] as RequestInit).body as string)
    const secondBody = JSON.parse((mockedAuthFetch.mock.calls[1][1] as RequestInit).body as string)
    expect(firstBody.model).toBe("gpt-5.4-mini")
    expect(secondBody.model).toBeUndefined()
    expect(result.current.createError).toBeNull()
  })

  it("createAndSend handles non-JSON error responses", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    mockedAuthFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error("not json")),
    } as Response)

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    expect(result.current.createError).toBe("Unknown error")
  })

  it("finalizes with an empty session the stream fills from the start when the transcript cannot be read yet", async () => {
    load.mockRejectedValueOnce(new Error("Failed to load session (404)"))
    const { result } = renderHook(() => useNewSession(defaultOpts))
    act(() => {
      result.current.handleNewSession("dir1")
    })
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ dirName: "dir1", fileName: "s.jsonl", sessionId: "sid" }),
    } as Response)

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    expect(result.current.createError).toBeNull()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "FINALIZE_SESSION",
        session: expect.objectContaining({ sessionId: "sid", turns: [] }),
        source: expect.objectContaining({ dirName: "dir1", fileName: "s.jsonl", watchOffset: 0 }),
      })
    )
    expect(onSessionFinalized).toHaveBeenCalled()
  })

  it("keeps the session's identity when its transcript is still empty, resuming where the tail ended", async () => {
    load.mockImplementationOnce(async (address) => ({
      parsed: { ...mockSession, sessionId: "" },
      source: { ...address, watchOffset: 12, loadId: 8 },
    }))
    const { result } = renderHook(() => useNewSession(defaultOpts))
    act(() => {
      result.current.handleNewSession("dir1")
    })
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ dirName: "dir1", fileName: "s.jsonl", sessionId: "sid" }),
    } as Response)

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "FINALIZE_SESSION",
        session: expect.objectContaining({ sessionId: "sid" }),
        source: expect.objectContaining({ watchOffset: 12 }),
      })
    )
  })

  it("does not finalize a session the user has already left", async () => {
    vi.mocked(sessions.openSession).mockResolvedValueOnce("superseded")
    const onCreated = vi.fn()
    const { result } = renderHook(() => useNewSession(defaultOpts))
    act(() => {
      result.current.handleNewSession("dir1")
    })
    mockedAuthFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ dirName: "dir1", fileName: "s.jsonl", sessionId: "sid" }),
    } as Response)

    await act(async () => {
      await result.current.createAndSend("hello", undefined, onCreated)
    })

    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "FINALIZE_SESSION" }))
    expect(onCreated).not.toHaveBeenCalled()
    expect(onSessionFinalized).not.toHaveBeenCalled()
  })

  it("createAndSend handles network errors", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    mockedAuthFetch.mockRejectedValueOnce(new Error("Network failure"))

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    expect(result.current.createError).toBe("Network failure")
    expect(result.current.creatingSession).toBe(false)
  })

  it("createAndSend ignores aborted requests", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    // Simulate abort error
    const abortError = new DOMException("Aborted", "AbortError")
    mockedAuthFetch.mockImplementationOnce((_url, init) => {
      // Simulate the abort controller being triggered
      const signal = (init as RequestInit)?.signal
      if (signal) {
        Object.defineProperty(signal, "aborted", { value: true })
      }
      return Promise.reject(abortError)
    })

    // Start first request
    const promise1 = act(async () => {
      await result.current.createAndSend("first")
    })

    await promise1
    // Aborted request should not set createError (the catch checks signal.aborted)
  })

  it("clearCreateError clears the error", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    mockedAuthFetch.mockRejectedValueOnce(new Error("fail"))

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    expect(result.current.createError).toBe("fail")

    act(() => {
      result.current.clearCreateError()
    })

    expect(result.current.createError).toBeNull()
  })

  it("createAndSend sends images when provided", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
    })

    mockedAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dirName: "dir1", fileName: "s.jsonl", sessionId: "sid" }),
      } as Response)

    const images = [{ data: "base64data", mediaType: "image/png" }]

    await act(async () => {
      await result.current.createAndSend("describe this", images)
    })

    const body = JSON.parse((mockedAuthFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.images).toEqual(images)
    expect(body.message).toBe("describe this")
    expect(body.dirName).toBe("dir1")
  })

  it("passes isMobile=true correctly", () => {
    const { result } = renderHook(() =>
      useNewSession({ ...defaultOpts, isMobile: true })
    )

    act(() => {
      result.current.handleNewSession("dir1")
    })

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ isMobile: true })
    )
  })

  it("auto-generates worktreeName from message when worktree is enabled", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
      result.current.setWorktreeEnabled(true)
    })

    mockedAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dirName: "dir1", fileName: "s.jsonl", sessionId: "sid" }),
      } as Response)

    await act(async () => {
      await result.current.createAndSend("Fix the auth token refresh logic")
    })

    const body = JSON.parse((mockedAuthFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.worktreeName).toBe("fix-the-auth-token-refresh-logic")
  })

  it("does not pass worktreeName when worktree is disabled", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("dir1")
      // worktreeEnabled defaults to false
    })

    mockedAuthFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dirName: "dir1", fileName: "s.jsonl", sessionId: "sid" }),
      } as Response)

    await act(async () => {
      await result.current.createAndSend("hello")
    })

    const body = JSON.parse((mockedAuthFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.worktreeName).toBeUndefined()
  })

  it("recovers Codex sessions from project listing when create returns the stale exit-0 error", async () => {
    const { result } = renderHook(() => useNewSession(defaultOpts))

    act(() => {
      result.current.handleNewSession("codex__L3RtcC9wcm9qZWN0", "/tmp/project")
    })

    mockedAuthFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "codex exited with code 0" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          sessions: [
            {
              fileName: "2026/03/18/rollout-2026-03-18T16-48-59-session.jsonl",
              sessionId: "codex-session-1",
              firstUserMessage: "hello codex",
              lastModified: new Date().toISOString(),
            },
          ],
        }),
      } as Response)

    let sessionId: string | null = null
    await act(async () => {
      sessionId = await result.current.createAndSend("hello codex")
    })

    expect(sessionId).toBe("codex-session-1")
    expect(result.current.createError).toBeNull()
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "FINALIZE_SESSION",
        source: expect.objectContaining({
          dirName: "codex__L3RtcC9wcm9qZWN0",
          fileName: "2026/03/18/rollout-2026-03-18T16-48-59-session.jsonl",
        }),
      })
    )
  })

  it("owns a recovered Codex session before showing it, and learns the listing's access", async () => {
    const alice = { id: "u_alice", username: "alice", displayName: "Alice" }
    setMe({
      authenticated: true,
      edition: "team",
      user: { ...alice },
      capabilities: NO_CAPABILITIES,
      enforcesSessionAccess: true,
    })
    const accessWhenShown = vi.fn()
    dispatch.mockImplementation((action: { type: string }) => {
      if (action.type === "FINALIZE_SESSION") accessWhenShown(knownSessionAccess("codex-session-1"))
    })
    const { result } = renderHook(() => useNewSession(defaultOpts))
    act(() => {
      result.current.handleNewSession("codex__L3RtcC9wcm9qZWN0", "/tmp/project")
    })
    const now = new Date().toISOString()
    mockedAuthFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: "codex exited with code 0" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          sessions: [
            { fileName: "a.jsonl", sessionId: "codex-session-1", firstUserMessage: "hello codex", lastModified: now },
            {
              fileName: "b.jsonl",
              sessionId: "codex-session-2",
              lastModified: now,
              access: { level: "view", mine: false },
            },
          ],
        }),
      } as Response)

    await act(async () => {
      await result.current.createAndSend("hello codex")
    })

    expect(accessWhenShown).toHaveBeenCalledWith("own")
    expect(knownSessionAccess("codex-session-2")).toBe("view")
    __resetCapabilitiesForTest()
    __resetSessionAccessForTest()
  })

  describe("recovery from a listing that names each session's access", () => {
    const access = (mine: boolean): ListedAccess => ({ level: "view", mine })

    afterEach(() => {
      __resetCapabilitiesForTest()
    })

    /** Fail the create with `failure`, then list `sessions` for recovery. */
    async function recoverFrom(
      sessions: Array<{ sessionId: string; access?: ListedAccess }>,
      failure: { status: number; body: { error: string; code?: string } } = { status: 500, body: { error: "codex exited with code 0" } },
    ) {
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => {
        result.current.handleNewSession("codex__L3RtcC9wcm9qZWN0", "/tmp/project")
      })
      mockedAuthFetch
        .mockResolvedValueOnce({
          ok: false,
          status: failure.status,
          json: () => Promise.resolve(failure.body),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            sessions: sessions.map((session) => ({
              ...session,
              fileName: `${session.sessionId}.jsonl`,
              firstUserMessage: "hello codex",
              lastModified: new Date().toISOString(),
            })),
          }),
        } as Response)

      let sessionId: string | null = null
      await act(async () => {
        sessionId = await result.current.createAndSend("hello codex")
      })
      return { sessionId, result }
    }

    it("adopts the caller's own session, not a newer one shared with them", async () => {
      const { sessionId } = await recoverFrom([
        { sessionId: "shared-session", access: access(false) },
        { sessionId: "own-session", access: access(true) },
      ])

      expect(sessionId).toBe("own-session")
      expect(renameSession).toHaveBeenCalledWith("own-session", "hello codex")
    })

    it("adopts nothing when the server refused the start as unconfirmed, though an own session is recent", async () => {
      const refusal = "Cogpit could not confirm the new session; an admin can assign it once it appears"
      const { sessionId, result } = await recoverFrom(
        [{ sessionId: "own-session", access: access(true) }],
        { status: 502, body: { code: "SESSION_UNCONFIRMED", error: refusal } },
      )

      expect(sessionId).toBeNull()
      expect(result.current.createError).toBe(refusal)
      expect(mockedAuthFetch).toHaveBeenCalledTimes(1)
      expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "FINALIZE_SESSION" }))
      expect(renameSession).not.toHaveBeenCalled()
    })

    it("adopts nothing when every candidate belongs to someone else", async () => {
      const { sessionId, result } = await recoverFrom([
        { sessionId: "shared-session", access: access(false) },
      ])

      expect(sessionId).toBeNull()
      expect(result.current.createError).toBe("codex exited with code 0")
    })

    it("adopts from a listing without access, as a personal server sends it, whatever edition the hub runs", async () => {
      setMe({
        authenticated: true,
        edition: "team",
        user: { id: "u_me", username: "me", displayName: "Me" },
        capabilities: ALL_CAPABILITIES,
        enforcesSessionAccess: true,
      })

      const { sessionId } = await recoverFrom([{ sessionId: "device-session" }])

      expect(sessionId).toBe("device-session")
    })
  })

  describe("with Code Mode on", () => {
    const runner = { ready: true, start: vi.fn(), show: vi.fn(), status: vi.fn<CodeModeRunner["status"]>() }
    let unregister: () => void

    beforeEach(() => {
      setCodeModeEnabled("local", true)
      runner.ready = true
      runner.status.mockReturnValue("running")
      unregister = registerCodeModeRunner("local", runner)
    })

    afterEach(() => {
      unregister()
      setCodeModeEnabled("local", false)
      vi.useRealTimers()
      window.history.replaceState(null, "", "/")
    })

    function found(dirName: string, fileName: string): Response {
      return { ok: true, json: () => Promise.resolve({ dirName, fileName }) } as Response
    }

    it("starts the session in the terminal and opens it once the CLI has written it", async () => {
      const { result } = renderHook(() => useNewSession({ ...defaultOpts, model: "claude-opus-5-5" }))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })
      mockedAuthFetch.mockImplementation(async (url) => found("-tmp-my-project", `${String(url).split("/").pop()}.jsonl`))

      let sessionId: string | null = null
      await act(async () => { sessionId = await result.current.createAndSend("fix the bug") })
      expect(result.current.createError).toBeNull()

      expect(runner.start).toHaveBeenCalledWith({
        kind: "claude",
        sessionId,
        resume: false,
        cwd: "/tmp/my-project",
        prompt: "fix the bug",
        model: "claude-opus-5-5",
        effort: "high",
        permissions: permissionsConfig,
      })
      // Nothing goes through the SDK: the only requests look the session up.
      expect(mockedAuthFetch.mock.calls.map(([url]) => url)).toEqual([`/api/find-session/${sessionId}`])
      expect(sessions.openSession).toHaveBeenCalledWith(
        { dirName: "-tmp-my-project", fileName: `${sessionId}.jsonl` },
        expect.objectContaining({ reason: "finalize" }),
      )
      expect(renameSession).toHaveBeenCalledWith(sessionId, "fix the bug")
    })

    it("finds the folder of a project opened without one", async () => {
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project") })
      mockedAuthFetch.mockImplementation(async (url) => url === "/api/projects"
        ? { ok: true, json: () => Promise.resolve([{ dirName: "-tmp-other", path: "/tmp/other" }, { dirName: "-tmp-my-project", path: "/tmp/my-project" }]) } as Response
        : found("-tmp-my-project", "s.jsonl"))

      await act(async () => { await result.current.createAndSend("hello") })

      expect(runner.start).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/tmp/my-project" }))
    })

    it("says so when the terminal ends before the CLI writes the session", async () => {
      runner.status.mockReturnValue("exited")
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })
      mockedAuthFetch.mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response)

      let sessionId: string | null = "unset"
      await act(async () => { sessionId = await result.current.createAndSend("hello") })

      expect(sessionId).toBeNull()
      expect(result.current.createError).toBe("Claude Code ended before starting the session. Its output is in the terminal.")
      expect(sessions.openSession).not.toHaveBeenCalled()
    })

    it("gives up when no terminal ever appears, as when the server refused the spawn", async () => {
      vi.useFakeTimers()
      runner.status.mockReturnValue(null)
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })
      mockedAuthFetch.mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response)

      let sessionId: string | null = "unset"
      await act(async () => {
        const created = result.current.createAndSend("hello").then((id) => { sessionId = id })
        await vi.advanceTimersByTimeAsync(16_000)
        await created
      })

      expect(sessionId).toBeNull()
      expect(result.current.createError).toBe("The terminal for Claude Code didn't start.")
    })

    it("waits while another machine is on screen and opens the session back on its own", async () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })
      let lookups = 0
      mockedAuthFetch.mockImplementation(async (url) => {
        lookups++
        // The user switches machines while the first lookup is in flight.
        if (lookups === 1) window.history.replaceState(null, "", "/d/box/")
        return found("-tmp-my-project", `${String(url).split("/").pop()}.jsonl`)
      })

      let settled = false
      await act(async () => {
        const created = result.current.createAndSend("hello").then(() => { settled = true })
        await vi.advanceTimersByTimeAsync(5_000)
        expect(settled).toBe(false)
        expect(lookups).toBe(1)

        window.history.replaceState(null, "", "/")
        await vi.advanceTimersByTimeAsync(1_000)
        await created
      })

      expect(sessions.openSession).toHaveBeenCalledTimes(1)
      expect(lookups).toBe(2)
    })

    it("keeps a provider-account instance's project on its normal sessions", async () => {
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("instance__work__-tmp-my-project", "/tmp/my-project") })
      mockedAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dirName: "instance__work__-tmp-my-project", fileName: "s.jsonl", sessionId: "i-1" }),
      } as Response)

      await act(async () => { await result.current.createAndSend("hello") })

      expect(runner.start).not.toHaveBeenCalled()
      expect(mockedAuthFetch.mock.calls[0][0]).toBe("/api/create-and-send")
    })

    it("asks to send again while the terminal is reconnecting, instead of starting a session without Code Mode", async () => {
      runner.ready = false
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })

      let sessionId: string | null = "unset"
      await act(async () => { sessionId = await result.current.createAndSend("hello") })

      expect(sessionId).toBeNull()
      expect(result.current.createError).toBe("The terminal is reconnecting. Send it again in a moment.")
      expect(runner.start).not.toHaveBeenCalled()
      expect(mockedAuthFetch).not.toHaveBeenCalled()
    })

    it("stops when the login has expired, instead of polling a server that wants a sign-in", async () => {
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })
      mockedAuthFetch.mockRejectedValue(new AuthRequiredError())

      await act(async () => { await result.current.createAndSend("hello") })

      expect(result.current.createError).toBe("This server didn't let Cogpit open the new session.")
    })

    it("refuses Worktree even when the prompt gives no worktree name", async () => {
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => {
        result.current.handleNewSession("-tmp-my-project", "/tmp/my-project")
        result.current.setWorktreeEnabled(true)
      })

      await act(async () => { await result.current.createAndSend("修复测试") })

      expect(runner.start).not.toHaveBeenCalled()
      expect(result.current.createError).toMatch(/can't start in a new worktree/)
    })

    it("lets a new draft end the wait of a start still pending, so it never opens over the draft", async () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })
      mockedAuthFetch.mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response)

      let sessionId: string | null = "unset"
      await act(async () => {
        const created = result.current.createAndSend("first").then((id) => { sessionId = id })
        await vi.advanceTimersByTimeAsync(2_000)
        result.current.handleNewSession("-tmp-other", "/tmp/other")
        mockedAuthFetch.mockImplementation(async (url) => found("-tmp-my-project", `${String(url).split("/").pop()}.jsonl`))
        await vi.advanceTimersByTimeAsync(3_000)
        await created
      })

      expect(sessionId).toBeNull()
      expect(sessions.openSession).not.toHaveBeenCalled()
    })

    it("abandons a pending start when its machine pane goes away for good", async () => {
      vi.useFakeTimers()
      const lifetime = createPaneLifetime()
      const wrapper = ({ children }: { children: ReactNode }) => createElement(PaneLifetimeProvider, { value: lifetime }, children)
      const { result } = renderHook(() => useNewSession(defaultOpts), { wrapper })
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })
      mockedAuthFetch.mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response)

      let sessionId: string | null = "unset"
      await act(async () => {
        const created = result.current.createAndSend("hello").then((id) => { sessionId = id })
        await vi.advanceTimersByTimeAsync(2_000)
        lifetime.end()
        await vi.advanceTimersByTimeAsync(2_000)
        await created
      })

      expect(sessionId).toBeNull()
      const lookups = mockedAuthFetch.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(mockedAuthFetch.mock.calls.length).toBe(lookups)
    })

    it("refuses a new worktree, whose setup the terminal launch would skip", async () => {
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => {
        result.current.handleNewSession("-tmp-my-project", "/tmp/my-project")
        result.current.setWorktreeEnabled(true)
      })

      await act(async () => { await result.current.createAndSend("hello") })

      expect(result.current.createError).toBe("Code Mode sessions can't start in a new worktree yet. Turn off Worktree to start one.")
      expect(runner.start).not.toHaveBeenCalled()
    })

    it("starts nothing when the user switched machines while the project folder was looked up", async () => {
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project") })
      mockedAuthFetch.mockImplementation(async () => {
        window.history.replaceState(null, "", "/d/box/")
        return { ok: true, json: () => Promise.resolve([{ dirName: "-tmp-my-project", path: "/tmp/my-project" }]) } as Response
      })

      await act(async () => { await result.current.createAndSend("hello") })

      expect(runner.start).not.toHaveBeenCalled()
      expect(result.current.createError).toBe("You switched machines before the session started. Send it again.")
    })

    it("stops when the server will not let this caller see the new session", async () => {
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })
      mockedAuthFetch.mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve({}) } as Response)

      await act(async () => { await result.current.createAndSend("hello") })

      expect(result.current.createError).toBe("This server didn't let Cogpit open the new session.")
    })

    it("bounds a lookup that never answers, so the deadline for a missing terminal still applies", async () => {
      vi.useFakeTimers()
      runner.status.mockReturnValue(null)
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })
      mockedAuthFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
      }))

      await act(async () => {
        const created = result.current.createAndSend("hello")
        await vi.advanceTimersByTimeAsync(25_000)
        await created
      })

      expect(result.current.createError).toBe("The terminal for Claude Code didn't start.")
    })

    it("waits through a reconnecting terminal panel instead of reading it as an exit", async () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })
      let lookups = 0
      mockedAuthFetch.mockImplementation(async (url) => {
        lookups++
        // The panel's socket drops after the terminal was seen running.
        if (lookups === 1) runner.ready = false
        if (lookups < 4) return { ok: false, status: 404, json: () => Promise.resolve({}) } as Response
        return found("-tmp-my-project", `${String(url).split("/").pop()}.jsonl`)
      })

      await act(async () => {
        const created = result.current.createAndSend("hello")
        await vi.advanceTimersByTimeAsync(3_000)
        runner.ready = true
        await vi.advanceTimersByTimeAsync(3_000)
        await created
      })

      expect(result.current.createError).toBeNull()
      expect(sessions.openSession).toHaveBeenCalledOnce()
    })

    it("refuses attached images, which the terminal cannot take", async () => {
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("-tmp-my-project", "/tmp/my-project") })

      await act(async () => { await result.current.createAndSend("look", [{ data: "aGk=", mediaType: "image/png" }]) })

      expect(runner.start).not.toHaveBeenCalled()
      expect(result.current.createError).toMatch(/can't take attached images/)
    })

    it("starts an agent without Code Mode through its SDK as before", async () => {
      const { result } = renderHook(() => useNewSession(defaultOpts))
      act(() => { result.current.handleNewSession("codex__-tmp-my-project", "/tmp/my-project") })
      mockedAuthFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ dirName: "codex__-tmp-my-project", fileName: "s.jsonl", sessionId: "codex-1" }),
      } as Response)

      await act(async () => { await result.current.createAndSend("hello") })

      expect(runner.start).not.toHaveBeenCalled()
      expect(mockedAuthFetch.mock.calls[0][0]).toBe("/api/create-and-send")
    })
  })
})
