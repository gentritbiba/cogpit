// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mutable Maps must be hoisted so vi.mock factory can reference them
// ---------------------------------------------------------------------------
const { mockActiveProcesses, mockPersistentSessions } = vi.hoisted(() => {
  const mockActiveProcesses = new Map<string, { pid: number; kill: ReturnType<typeof vi.fn> }>()
  const mockPersistentSessions = new Map<string, {
    dead: boolean
    proc: { pid: number; kill: ReturnType<typeof vi.fn> }
  }>()
  return { mockActiveProcesses, mockPersistentSessions }
})

vi.mock("../../helpers", () => ({
  activeProcesses: mockActiveProcesses,
  persistentSessions: mockPersistentSessions,
  dirs: { PROJECTS_DIR: "/tmp/test-projects" },
  isCodexDirName: vi.fn(() => false),
  isWithinDir: vi.fn(() => true),
  resolveSessionFilePath: vi.fn(),
  unlink: vi.fn().mockResolvedValue(undefined),
  spawn: vi.fn(),
}))

vi.mock("../../sdk-session", () => ({
  stopSDKSession: vi.fn(() => false),
  cleanupAllSDKSessions: vi.fn(() => 0),
}))

import type { UseFn, Middleware } from "../../helpers"
import { registerClaudeManageRoutes } from "../../routes/claude-manage"

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

function makeMockPersistentSession(pid: number, dead = false) {
  return {
    dead,
    proc: makeMockProc(pid),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("claude-manage routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    mockActiveProcesses.clear()
    mockPersistentSessions.clear()

    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => {
      handlers.set(path, handler)
    }
    registerClaudeManageRoutes(use)
  })

  // -------------------------------------------------------------------------
  // kill-all: Map mutation during iteration (Bug #1) + snapshot bug (Bug #2)
  // -------------------------------------------------------------------------
  describe("POST /api/kill-all", () => {
    it("kills all persistent sessions without Map mutation errors", () => {
      mockPersistentSessions.set("ps-1", makeMockPersistentSession(1001))
      mockPersistentSessions.set("ps-2", makeMockPersistentSession(1002))
      mockPersistentSessions.set("ps-3", makeMockPersistentSession(1003))

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      // Should NOT throw concurrent-modification-style errors
      expect(() => handler(req as never, res as never, next)).not.toThrow()
    })

    it("kills all active processes without Map mutation errors", () => {
      mockActiveProcesses.set("ap-1", makeMockProc(2001))
      mockActiveProcesses.set("ap-2", makeMockProc(2002))
      mockActiveProcesses.set("ap-3", makeMockProc(2003))

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      expect(() => handler(req as never, res as never, next)).not.toThrow()
    })

    it("sends SIGTERM to ALL persistent sessions and empties the Map", () => {
      const ps1 = makeMockPersistentSession(1001)
      const ps2 = makeMockPersistentSession(1002)
      const ps3 = makeMockPersistentSession(1003)
      mockPersistentSessions.set("ps-1", ps1)
      mockPersistentSessions.set("ps-2", ps2)
      mockPersistentSessions.set("ps-3", ps3)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)

      // Every proc must have received SIGTERM
      expect(ps1.proc.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ps2.proc.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ps3.proc.kill).toHaveBeenCalledWith("SIGTERM")

      // Map must be fully cleared
      expect(mockPersistentSessions.size).toBe(0)
    })

    it("sends SIGTERM to ALL active processes and empties the Map", () => {
      const ap1 = makeMockProc(2001)
      const ap2 = makeMockProc(2002)
      const ap3 = makeMockProc(2003)
      mockActiveProcesses.set("ap-1", ap1)
      mockActiveProcesses.set("ap-2", ap2)
      mockActiveProcesses.set("ap-3", ap3)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)

      expect(ap1.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ap2.kill).toHaveBeenCalledWith("SIGTERM")
      expect(ap3.kill).toHaveBeenCalledWith("SIGTERM")
      expect(mockActiveProcesses.size).toBe(0)
    })

    it("kills both persistent and active sessions together (5 total)", () => {
      const ps1 = makeMockPersistentSession(1001)
      const ps2 = makeMockPersistentSession(1002)
      const ap1 = makeMockProc(2001)
      const ap2 = makeMockProc(2002)
      const ap3 = makeMockProc(2003)

      mockPersistentSessions.set("ps-1", ps1)
      mockPersistentSessions.set("ps-2", ps2)
      mockActiveProcesses.set("ap-1", ap1)
      mockActiveProcesses.set("ap-2", ap2)
      mockActiveProcesses.set("ap-3", ap3)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)

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

    it("skips already-dead persistent sessions but still removes them from Map", () => {
      const deadPs = makeMockPersistentSession(1001, true) // dead = true
      const livePs = makeMockPersistentSession(1002, false)
      mockPersistentSessions.set("dead", deadPs)
      mockPersistentSessions.set("live", livePs)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)

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
    it("SIGKILL snapshot captures processes before Maps are cleared", () => {
      vi.useFakeTimers()

      const ps1 = makeMockPersistentSession(1001)
      const ap1 = makeMockProc(2001)
      mockPersistentSessions.set("ps-1", ps1)
      mockActiveProcesses.set("ap-1", ap1)

      const handler = handlers.get("/api/kill-all")!
      const { req, res, next } = createMockReqRes("POST", "/api/kill-all")

      handler(req as never, res as never, next)

      // Fast-forward 3+ seconds to trigger SIGKILL timeout
      vi.advanceTimersByTime(3100)

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

    it("returns 400 when sessionId is missing", () => {
      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", JSON.stringify({}))

      handler(req as never, res as never, next)
      sendBody()

      expect(res._getStatus()).toBe(400)
    })

    it("returns success:false when session not found", () => {
      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "nonexistent" })
      )

      handler(req as never, res as never, next)
      sendBody()

      const body = res._getData()
      expect(body.success).toBe(false)
    })

    it("kills a persistent session", () => {
      const ps = makeMockPersistentSession(1001)
      mockPersistentSessions.set("sess-1", ps)

      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "sess-1" })
      )

      handler(req as never, res as never, next)
      sendBody()

      expect(ps.proc.kill).toHaveBeenCalledWith("SIGTERM")
      expect(mockPersistentSessions.has("sess-1")).toBe(false)
      expect(res._getData().success).toBe(true)
    })

    it("kills an active process", () => {
      const ap = makeMockProc(2001)
      mockActiveProcesses.set("sess-2", ap)

      const handler = handlers.get("/api/stop-session")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ sessionId: "sess-2" })
      )

      handler(req as never, res as never, next)
      sendBody()

      expect(ap.kill).toHaveBeenCalledWith("SIGTERM")
      expect(res._getData().success).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // kill-process: pid lookup path
  // -------------------------------------------------------------------------
  describe("POST /api/kill-process", () => {
    it("returns 400 for missing pid", () => {
      const handler = handlers.get("/api/kill-process")!
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", JSON.stringify({}))

      handler(req as never, res as never, next)
      sendBody()

      expect(res._getStatus()).toBe(400)
    })

    it("returns 403 for untracked pid", () => {
      const handler = handlers.get("/api/kill-process")!
      const { req, res, next, sendBody } = createMockReqRes(
        "POST", "/", JSON.stringify({ pid: 9999 })
      )

      handler(req as never, res as never, next)
      sendBody()

      expect(res._getStatus()).toBe(403)
    })
  })
})
