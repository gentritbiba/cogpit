// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mutable Maps must be hoisted so vi.mock factory can reference them
// ---------------------------------------------------------------------------
const { mockCodexAppServer, mockSDKControls, mockCopilotRuntime, mockFindJsonlPath } = vi.hoisted(() => {
  const mockFindJsonlPath = vi.fn()
  const mockCodexAppServer = {
    getActiveTurnId: vi.fn(),
    listActiveTurns: vi.fn(),
    listApprovalThreadIds: vi.fn(() => []),
    interruptTurn: vi.fn(),
  }
  const mockSDKControls = {
    stopSDKSession: vi.fn(() => false),
    interruptSDKTurn: vi.fn(),
    updateSDKSession: vi.fn(),
    rewindClaudeFiles: vi.fn(),
    stopSDKTask: vi.fn(),
    backgroundSDKTasks: vi.fn(),
  }
  const mockCopilotRuntime = {
    isSessionActive: vi.fn(),
    isTurnActive: vi.fn(),
    getActiveSessionIds: vi.fn(),
    getPendingPermissions: vi.fn(() => []),
    getPendingUserInputs: vi.fn(() => []),
    abort: vi.fn(),
    destroySession: vi.fn(),
    deleteSession: vi.fn(),
  }
  return { mockCodexAppServer, mockSDKControls, mockCopilotRuntime, mockFindJsonlPath }
})

// The process registry itself is real: the teardown helpers close over its
// maps, so a stubbed copy would leave every kill assertion looking at nothing.
vi.mock("../../helpers", async () => {
  const registry = await vi.importActual<typeof import("../../processRegistry")>(
    "../../processRegistry",
  )
  return {
    activeProcesses: registry.activeProcesses,
    persistentSessions: registry.persistentSessions,
    unlink: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn(),
    join: (...parts: string[]) => parts.join("/"),
    readFile: vi.fn(),
    createInterface: vi.fn(() => ({ on: vi.fn() })),
    getSessionMeta: vi.fn().mockResolvedValue(null),
    homedir: () => "/Users/me",
  }
})

vi.mock("../../sessionPaths", () => ({
  resolveSessionFilePath: vi.fn(),
  findJsonlPath: mockFindJsonlPath,
  findNewestCodexSessionForCwd: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../agents", () => {
  const roots: Record<string, string> = {
    claude: "/tmp/test-projects",
    codex: "/tmp/codex/sessions",
    copilot: "/tmp/copilot/session-state",
  }
  return {
    storeFor: (kind: string) => ({
      kind,
      sessionsRoot: () => roots[kind],
      listSessionFiles: vi.fn().mockResolvedValue([]),
    }),
    storeForPath: (filePath: string | null) => {
      if (!filePath) return null
      const kind = Object.keys(roots).find((key) => filePath.startsWith(`${roots[key]}/`))
      return kind ? { kind } : null
    },
  }
})

vi.mock("../../sdk-session", () => ({
  cleanupAllSDKSessions: vi.fn(() => 0),
  ...mockSDKControls,
}))

vi.mock("../../agents/codexAppServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/codexAppServer")>()
  return { ...actual, codexAppServer: mockCodexAppServer }
})

vi.mock("../../agents/copilotTransport", () => ({ copilotRuntime: mockCopilotRuntime }))

import { unlink } from "../../helpers"
import {
  activeProcesses as mockActiveProcesses,
  persistentSessions as mockPersistentSessions,
  type PersistentSession,
} from "../../processRegistry"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { resolveSessionFilePath } from "../../sessionPaths"
import type { UseFn, Middleware } from "../../helpers"
import { registerSessionManageRoutes } from "../../routes/session-manage"

// ---------------------------------------------------------------------------
// Helper to create mock req/res objects
// ---------------------------------------------------------------------------
function createMockReqRes(method: string, url = "/", body?: string) {
  const dataHandlers: ((chunk: Buffer) => void)[] = []
  const endHandlers: (() => void)[] = []

  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: Buffer) => void)
      if (event === "end") endHandlers.push(handler as () => void)
      return req
    }),
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  }

  let endData = ""
  let statusCode = 200
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => { endData = data || "" }),
    _getData: () => JSON.parse(endData || "{}"),
    _getStatus: () => statusCode,
  }

  const next = vi.fn()

  const sendBody = () => {
    if (body) {
      for (const h of dataHandlers) h(Buffer.from(body))
    }
    for (const h of endHandlers) h()
  }

  return { req, res, next, sendBody }
}

function makeMockProc(pid: number) {
  return { pid, kill: vi.fn() }
}

type MockPersistentSession = {
  dead: boolean
  agentKind?: string
  jsonlPath?: string | null
  proc: { pid: number; kill: ReturnType<typeof vi.fn> }
}

function makeMockPersistentSession(pid: number, dead = false): MockPersistentSession {
  return { dead, proc: makeMockProc(pid) }
}

/** Register a stand-in child in the real registry the routes read. */
function trackPersistent(sessionId: string, session: MockPersistentSession): void {
  mockPersistentSessions.set(sessionId, session as unknown as PersistentSession)
}

function trackProcess(sessionId: string, proc: { pid: number; kill: ReturnType<typeof vi.fn> }): void {
  mockActiveProcesses.set(sessionId, proc as unknown as PersistentSession["proc"])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("session lifecycle routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    mockActiveProcesses.clear()
    mockPersistentSessions.clear()
    mockCodexAppServer.getActiveTurnId.mockReturnValue(undefined)
    mockCodexAppServer.listActiveTurns.mockReturnValue([])
    mockCodexAppServer.interruptTurn.mockResolvedValue({})
    mockCopilotRuntime.isSessionActive.mockReturnValue(false)
    mockCopilotRuntime.isTurnActive.mockReturnValue(false)
    mockCopilotRuntime.getActiveSessionIds.mockReturnValue([])
    mockCopilotRuntime.abort.mockResolvedValue(undefined)
    mockCopilotRuntime.destroySession.mockResolvedValue(undefined)
    mockCopilotRuntime.deleteSession.mockResolvedValue({ success: true })
    mockCopilotRuntime.getPendingPermissions.mockReturnValue([])
    mockCopilotRuntime.getPendingUserInputs.mockReturnValue([])
    mockCodexAppServer.listApprovalThreadIds.mockReturnValue([])
    // Sessions are resolved by whose storage holds the transcript; an id with
    // no file at all is Claude's, which is what an unknown id resolves to.
    mockFindJsonlPath.mockResolvedValue(null)
    vi.mocked(resolveSessionFilePath).mockResolvedValue(null)
    mockSDKControls.stopSDKSession.mockReturnValue(false)
    mockSDKControls.interruptSDKTurn.mockResolvedValue(true)
    mockSDKControls.updateSDKSession.mockResolvedValue({ found: true, appliedLive: ["model"], staged: [] })
    mockSDKControls.rewindClaudeFiles.mockResolvedValue({ canRewind: true })
    mockSDKControls.stopSDKTask.mockResolvedValue(true)
    mockSDKControls.backgroundSDKTasks.mockResolvedValue(true)

    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => {
      handlers.set(path, handler)
    }
    registerSessionManageRoutes(use)
  })

  describe("native Claude controls", () => {
    it("applies session settings live", async () => {
      const handler = handlers.get("/api/claude/settings")!
      const updates = { model: "claude-opus-4-6", fastMode: true, permissionMode: "auto" }
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/session-1", JSON.stringify(updates),
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockSDKControls.updateSDKSession).toHaveBeenCalledWith("session-1", updates)
      expect(res._getData()).toEqual({
        success: true,
        found: true,
        appliedLive: ["model"],
        staged: [],
      })
    })

    it("interrupts an active Claude SDK turn", async () => {
      const handler = handlers.get("/api/interrupt-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "claude-session" }),
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockSDKControls.interruptSDKTurn).toHaveBeenCalledWith("claude-session")
      expect(res._getData()).toEqual({ success: true })
    })

    it("interrupts an active Copilot turn", async () => {
      mockCopilotRuntime.isSessionActive.mockReturnValue(true)
      mockCopilotRuntime.isTurnActive.mockReturnValue(true)
      const handler = handlers.get("/api/interrupt-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "copilot-session" }),
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockCopilotRuntime.abort).toHaveBeenCalledWith("copilot-session")
      expect(mockSDKControls.interruptSDKTurn).not.toHaveBeenCalled()
      expect(res._getData()).toEqual({ success: true })
    })

    it("answers when the runtime's interrupt rejects", async () => {
      // Regression: the transport RPC behind interrupt sat outside any
      // try/catch, so a rejection left the request hanging forever and raised
      // an unhandled rejection that can take the process down.
      mockCopilotRuntime.isSessionActive.mockReturnValue(true)
      mockCopilotRuntime.isTurnActive.mockReturnValue(true)
      mockCopilotRuntime.abort.mockRejectedValue(new Error("transport lost"))
      const handler = handlers.get("/api/interrupt-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "copilot-session" }),
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(res._getStatus()).toBeGreaterThanOrEqual(400)
      expect(res._getStatus()).toBeLessThan(600)
      expect(res._getData()).toEqual(expect.objectContaining({ error: expect.any(String) }))
    })

    it("leaves an idle external session to its own runtime", async () => {
      // Regression: interrupt used to identify Codex by "does it have a turn
      // running right now", so an idle Codex session fell through to the Claude
      // SDK, which silently did nothing about a session it never opened.
      mockFindJsonlPath.mockResolvedValue(
        "/tmp/codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-thread-idle.jsonl",
      )
      const handler = handlers.get("/api/interrupt-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "thread-idle" }),
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockSDKControls.interruptSDKTurn).not.toHaveBeenCalled()
      expect(mockCodexAppServer.interruptTurn).not.toHaveBeenCalled()
      expect(res._getData()).toEqual({ success: false })
    })

    it("rewinds files to a native checkpoint", async () => {
      const handler = handlers.get("/api/claude/checkpoints")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST",
        "/session-1/rewind",
        JSON.stringify({ userMessageId: "message-1", cwd: "/tmp/project", dryRun: true }),
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockSDKControls.rewindClaudeFiles).toHaveBeenCalledWith(
        "session-1", "message-1", "/tmp/project", true,
      )
      expect(res._getData()).toEqual({ canRewind: true })
    })

    it("stops and backgrounds native agent tasks", async () => {
      const handler = handlers.get("/api/claude/tasks")!
      const stop = createMockReqRes("DELETE", "/session-1/task-7")
      handler(stop.req as never, stop.res as never, stop.next)
      await vi.waitFor(() => expect(stop.res.end).toHaveBeenCalled())
      expect(mockSDKControls.stopSDKTask).toHaveBeenCalledWith("session-1", "task-7")

      const background = createMockReqRes(
        "POST", "/session-1/background", JSON.stringify({ toolUseId: "tool-9" }),
      )
      handler(background.req as never, background.res as never, background.next)
      background.sendBody()
      await vi.waitFor(() => expect(background.res.end).toHaveBeenCalled())
      expect(mockSDKControls.backgroundSDKTasks).toHaveBeenCalledWith("session-1", "tool-9")
    })
  })

  // -------------------------------------------------------------------------
  // kill-all: Map mutation during iteration (Bug #1) + snapshot bug (Bug #2)
  // -------------------------------------------------------------------------
  describe("POST /api/kill-all", () => {
    it("kills all persistent sessions without Map mutation errors", () => {
      trackPersistent("ps-1", makeMockPersistentSession(1001))
      trackPersistent("ps-2", makeMockPersistentSession(1002))
      trackPersistent("ps-3", makeMockPersistentSession(1003))

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      // Should NOT throw concurrent-modification-style errors
      expect(() => handler(req as never, res as never, next)).not.toThrow()
    })

    it("kills all active processes without Map mutation errors", () => {
      trackProcess("ap-1", makeMockProc(2001))
      trackProcess("ap-2", makeMockProc(2002))
      trackProcess("ap-3", makeMockProc(2003))

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      expect(() => handler(req as never, res as never, next)).not.toThrow()
    })

    it("sends SIGTERM to ALL persistent sessions and empties the Map", async () => {
      const ps1 = makeMockPersistentSession(1001)
      const ps2 = makeMockPersistentSession(1002)
      const ps3 = makeMockPersistentSession(1003)
      trackPersistent("ps-1", ps1)
      trackPersistent("ps-2", ps2)
      trackPersistent("ps-3", ps3)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      // Every proc must have received SIGTERM
      expect(ps1.proc.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ps2.proc.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ps3.proc.kill).toHaveBeenCalledWith("SIGTERM")

      // Map must be fully cleared
      expect(mockPersistentSessions.size).toBe(0)
    })

    it("sends SIGTERM to ALL active processes and empties the Map", async () => {
      const ap1 = makeMockProc(2001)
      const ap2 = makeMockProc(2002)
      const ap3 = makeMockProc(2003)
      trackProcess("ap-1", ap1)
      trackProcess("ap-2", ap2)
      trackProcess("ap-3", ap3)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(ap1.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ap2.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ap3.kill).toHaveBeenCalledWith("SIGTERM")
      expect(mockActiveProcesses.size).toBe(0)
    })

    it("kills both persistent and active sessions together (5 total)", async () => {
      const ps1 = makeMockPersistentSession(1001)
      const ps2 = makeMockPersistentSession(1002)
      const ap1 = makeMockProc(2001)
      const ap2 = makeMockProc(2002)
      const ap3 = makeMockProc(2003)

      trackPersistent("ps-1", ps1)
      trackPersistent("ps-2", ps2)
      trackProcess("ap-1", ap1)
      trackProcess("ap-2", ap2)
      trackProcess("ap-3", ap3)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      // All 5 procs got SIGTERM
      expect(ps1.proc.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ps2.proc.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ap1.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ap2.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ap3.kill).toHaveBeenCalledWith("SIGTERM")

      // Both Maps fully cleared
      expect(mockPersistentSessions.size).toBe(0)
      expect(mockActiveProcesses.size).toBe(0)

      // Count: 0 SDK + 2 persistent + 3 active = 5
      const body = res._getData()
      expect(body.killed).toBe(5)
      expect(body.success).toBe(true)
    })

    it("interrupts every native parent and subagent turn before process cleanup", async () => {
      const pendingInterrupts: Array<() => void> = []
      mockCodexAppServer.listActiveTurns.mockReturnValue([
        { threadId: "thread-parent", turnId: "turn-parent" },
        { threadId: "thread-child", turnId: "turn-child" },
      ])
      mockCodexAppServer.interruptTurn.mockImplementation(
        () => new Promise<void>((resolve) => pendingInterrupts.push(resolve)),
      )
      const legacy = makeMockProc(2001)
      trackProcess("legacy", legacy)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")
      handler(req as never, res as never, next)

      expect(mockCodexAppServer.interruptTurn.mock.calls).toEqual([
        ["thread-parent", "turn-parent"],
        ["thread-child", "turn-child"],
      ])
      expect(legacy.kill).not.toHaveBeenCalled()
      expect(res.end).not.toHaveBeenCalled()

      pendingInterrupts.forEach((resolve) => resolve())
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(legacy.kill).toHaveBeenCalledWith("SIGTERM")
      expect(res._getData()).toEqual({ success: true, killed: 3 })
    })

    it("destroys every loaded Copilot session", async () => {
      mockCopilotRuntime.getActiveSessionIds.mockReturnValue(["copilot-1", "copilot-2"])
      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockCopilotRuntime.destroySession.mock.calls).toEqual([
        ["copilot-1"],
        ["copilot-2"],
      ])
      expect(res._getData()).toEqual({ success: true, killed: 2 })
    })

    it("skips already-dead persistent sessions but still removes them from Map", async () => {
      const deadPs = makeMockPersistentSession(1001, true) // dead = true
      const livePs = makeMockPersistentSession(1002, false)
      trackPersistent("dead", deadPs)
      trackPersistent("live", livePs)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      // Dead proc should NOT receive kill
      expect(deadPs.proc.kill).not.toHaveBeenCalled()
      // Live proc should receive SIGTERM
      expect(livePs.proc.kill).toHaveBeenCalledWith("SIGTERM")
      // Map still emptied
      expect(mockPersistentSessions.size).toBe(0)
    })

    it("returns 405 for non-POST requests", () => {
      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("GET", "/api/kill-all")

      handler(req as never, res as never, next)

      expect(next).toHaveBeenCalled()
    })

    // -----------------------------------------------------------------------
    // Bug #2: snapshot for SIGKILL must capture procs BEFORE Maps are cleared
    // -----------------------------------------------------------------------
    it("SIGKILL snapshot captures processes before Maps are cleared", async () => {
      vi.useFakeTimers()
      const ps1 = makeMockPersistentSession(1001)
      const ap1 = makeMockProc(2001)
      trackPersistent("ps-1", ps1)
      trackProcess("ap-1", ap1)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)

      // Fast-forward past the SIGTERM grace window, flushing the runtime
      // stop-all promises the sweep waits on along the way.
      await vi.advanceTimersByTimeAsync(3100)

      // Both procs should have received SIGKILL via the delayed timeout
      expect(ps1.proc.kill).toHaveBeenCalledWith("SIGKILL")
      expect(ap1.kill).toHaveBeenCalledWith("SIGKILL")

      vi.useRealTimers()
    })
  })

  // -------------------------------------------------------------------------
  // stop-session
  // -------------------------------------------------------------------------
  describe("POST /api/stop-session", () => {
    it("calls next for non-POST methods", () => {
      const handler = handlers.get("/api/stop-session")!
      const { req, res, next } = createMockReqRes("GET")

      handler(req as never, res as never, next)

      expect(next).toHaveBeenCalled()
    })

    it("returns 400 when sessionId is missing", async () => {
      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", JSON.stringify({}))

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(res._getStatus()).toBe(400)
      const body = res._getData()
      expect(body.code).toBe("INVALID_REQUEST")
    })

    it("returns success:false when session not found", async () => {
      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "nonexistent" })
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      const body = res._getData()
      expect(body.success).toBe(false)
    })

    it("kills a persistent session", async () => {
      const ps = makeMockPersistentSession(1001)
      trackPersistent("sess-1", ps)

      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "sess-1" })
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(ps.proc.kill).toHaveBeenCalledWith("SIGTERM")
      expect(mockPersistentSessions.has("sess-1")).toBe(false)
      expect(res._getData().success).toBe(true)
    })

    it("kills an active process", async () => {
      const ap = makeMockProc(2001)
      trackProcess("sess-2", ap)

      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "sess-2" })
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(ap.kill).toHaveBeenCalledWith("SIGTERM")
      expect(res._getData().success).toBe(true)
    })

    it("interrupts a native Codex turn without inventing a process", async () => {
      mockCodexAppServer.getActiveTurnId.mockReturnValue("turn-native")
      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "thread-native" })
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockCodexAppServer.interruptTurn).toHaveBeenCalledWith(
        "thread-native",
        "turn-native",
      )
      expect(res._getData()).toEqual({ success: true })
    })

    it("aborts and destroys a loaded Copilot session", async () => {
      mockCopilotRuntime.isSessionActive.mockReturnValue(true)
      mockCopilotRuntime.isTurnActive.mockReturnValue(true)
      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "copilot-session" }),
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockCopilotRuntime.abort).toHaveBeenCalledWith("copilot-session")
      expect(mockCopilotRuntime.destroySession).toHaveBeenCalledWith("copilot-session")
      expect(res._getData()).toEqual({ success: true })
    })

    it("answers when the runtime's stop rejects", async () => {
      // Same regression as interrupt: the codex path only looks covered because
      // codexRuntime.stop swallows its own failure internally. Copilot's stop
      // lets the transport rejection out, which is what the route must answer.
      mockCopilotRuntime.isSessionActive.mockReturnValue(true)
      mockCopilotRuntime.isTurnActive.mockReturnValue(false)
      mockCopilotRuntime.destroySession.mockRejectedValue(new Error("transport lost"))
      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "copilot-session" }),
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(res._getStatus()).toBeGreaterThanOrEqual(400)
      expect(res._getStatus()).toBeLessThan(600)
      expect(res._getData()).toEqual(expect.objectContaining({ error: expect.any(String) }))
    })

    it("does not ask the Claude SDK to stop an idle external session", async () => {
      mockFindJsonlPath.mockResolvedValue(
        "/tmp/codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-thread-idle.jsonl",
      )
      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "thread-idle" }),
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockSDKControls.stopSDKSession).not.toHaveBeenCalled()
      expect(res._getData()).toEqual({
        success: false,
        error: "No active process for this session",
      })
    })

    it("tries native interruption before falling back to a legacy process", async () => {
      mockCodexAppServer.getActiveTurnId.mockReturnValue("turn-native")
      mockCodexAppServer.interruptTurn.mockRejectedValue(new Error("transport lost"))
      const ps = { ...makeMockPersistentSession(1001), agentKind: "codex", jsonlPath: null }
      trackPersistent("sess-legacy", ps)
      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "sess-legacy" })
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockCodexAppServer.interruptTurn).toHaveBeenCalled()
      expect(ps.proc.kill).toHaveBeenCalledWith("SIGTERM")
      expect(mockCodexAppServer.interruptTurn.mock.invocationCallOrder[0])
        .toBeLessThan(ps.proc.kill.mock.invocationCallOrder[0])
    })
  })

  describe("POST /api/delete-session", () => {
    it("uses Copilot's permanent-delete RPC after disconnecting a loaded session", async () => {
      const copilotSessionId = "44444444-4444-4444-4444-444444444444"
      vi.mocked(resolveSessionFilePath).mockResolvedValue(
        `/tmp/copilot/session-state/${copilotSessionId}/events.jsonl`,
      )
      mockCopilotRuntime.isSessionActive.mockReturnValue(true)
      mockCopilotRuntime.isTurnActive.mockReturnValue(true)
      const handler = handlers.get("/api/delete-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST",
        "/",
        JSON.stringify({
          dirName: descriptorFor("copilot").dirName.encode("/tmp/workspace"),
          fileName: `${copilotSessionId}/events.jsonl`,
        }),
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(mockCopilotRuntime.abort).toHaveBeenCalledWith(copilotSessionId)
      expect(mockCopilotRuntime.destroySession).toHaveBeenCalledWith(copilotSessionId)
      expect(mockCopilotRuntime.deleteSession).toHaveBeenCalledWith(copilotSessionId)
      expect(vi.mocked(unlink)).not.toHaveBeenCalled()
      expect(res._getData()).toEqual({ success: true })
    })
  })

  // -------------------------------------------------------------------------
  // kill-process: pid lookup path
  // -------------------------------------------------------------------------
  describe("POST /api/kill-process", () => {
    it("returns 400 for missing pid", async () => {
      const handler = handlers.get("/api/kill-process")!
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", JSON.stringify({}))

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(res._getStatus()).toBe(400)
      const body = res._getData()
      expect(body.code).toBe("INVALID_REQUEST")
    })

    it("returns 403 for untracked pid", async () => {
      const handler = handlers.get("/api/kill-process")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ pid: 9999 })
      )

      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())

      expect(res._getStatus()).toBe(403)
      const body = res._getData()
      expect(body.code).toBe("FORBIDDEN")
    })
  })
})
