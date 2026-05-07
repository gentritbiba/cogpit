// @vitest-environment node
/**
 * Tests for session spawn failure scenarios in claude-new/sessionSpawner.ts
 *
 * Coverage:
 *  - writeTempImageFiles / cleanupTempFiles helpers (real fs, direct unit tests)
 *  - registerNewSessionRoute: spawned process exits immediately (crash)
 *  - registerNewSessionRoute: spawn timeout path
 *  - registerNewSessionRoute: spawn error event
 *  - registerCreateAndSendRoute (Codex): crash before session identity → Maps stay empty
 *  - registerCreateAndSendRoute (Codex): temp image files cleaned up on crash / error
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFile, unlink, access } from "node:fs/promises"

// ---------------------------------------------------------------------------
// Hoisted mutable Maps and spy fns so vi.mock factory can reference them
// ---------------------------------------------------------------------------
const {
  mockActiveProcesses,
  mockPersistentSessions,
  mockSpawn,
  mockStat,
  mockReadFile,
  mockReaddir,
  mockWriteTempImageFiles,
  mockCleanupTempFiles,
  mockFriendlySpawnError,
  mockCreateInterface,
  mockListCodexSessionFiles,
  mockFindNewestCodexSession,
} = vi.hoisted(() => {
  const mockActiveProcesses = new Map<string, unknown>()
  const mockPersistentSessions = new Map<string, unknown>()
  const mockSpawn = vi.fn()
  const mockStat = vi.fn()
  const mockReadFile = vi.fn()
  const mockReaddir = vi.fn().mockResolvedValue([])
  const mockWriteTempImageFiles = vi.fn().mockResolvedValue([])
  const mockCleanupTempFiles = vi.fn().mockResolvedValue(undefined)
  const mockFriendlySpawnError = vi.fn((err: NodeJS.ErrnoException) => err.message)
  const mockCreateInterface = vi.fn(() => ({ on: vi.fn(), close: vi.fn() }))
  const mockListCodexSessionFiles = vi.fn().mockResolvedValue([])
  const mockFindNewestCodexSession = vi.fn().mockResolvedValue(null)
  return {
    mockActiveProcesses,
    mockPersistentSessions,
    mockSpawn,
    mockStat,
    mockReadFile,
    mockReaddir,
    mockWriteTempImageFiles,
    mockCleanupTempFiles,
    mockFriendlySpawnError,
    mockCreateInterface,
    mockListCodexSessionFiles,
    mockFindNewestCodexSession,
  }
})

// ---------------------------------------------------------------------------
// Mock ../../helpers
// ---------------------------------------------------------------------------
vi.mock("../../helpers", () => ({
  activeProcesses: mockActiveProcesses,
  persistentSessions: mockPersistentSessions,
  dirs: { PROJECTS_DIR: "/tmp/test-projects" },
  isWithinDir: vi.fn(() => true),
  isCodexDirName: vi.fn((d: string) => d.startsWith("codex:")),
  decodeCodexDirName: vi.fn((d: string) => (d.startsWith("codex:") ? d.replace("codex:", "") : null)),
  friendlySpawnError: mockFriendlySpawnError,
  spawn: mockSpawn,
  stat: mockStat,
  readFile: mockReadFile,
  open: vi.fn(),
  readdir: mockReaddir,
  join: (...parts: string[]) => parts.join("/"),
  randomUUID: vi.fn(() => "test-session-uuid"),
  listCodexSessionFiles: mockListCodexSessionFiles,
  findNewestCodexSessionForCwd: mockFindNewestCodexSession,
  formatCodexRolloutFileName: vi.fn(() => "2026/01/01/rollout-test.jsonl"),
  buildPermArgs: vi.fn(() => ["--dangerously-skip-permissions"]),
  buildCodexPermArgs: vi.fn(() => []),
  buildCodexModelArgs: vi.fn(() => []),
  buildCodexEffortArgs: vi.fn(() => []),
  writeTempImageFiles: mockWriteTempImageFiles,
  cleanupTempFiles: mockCleanupTempFiles,
  findJsonlPath: vi.fn().mockResolvedValue(null),
  createInterface: mockCreateInterface,
  CODEX_SESSIONS_DIR: "/tmp/.codex/sessions",
}))

vi.mock("../../sdk-session", () => ({
  createSDKSession: vi.fn(() => ({
    sessionId: "test-session-uuid",
    jsonlPath: null,
    onResult: null,
    cwd: "/tmp/test",
    proc: { kill: vi.fn() },
    dead: false,
  })),
  attachSubagentWatcher: vi.fn(),
}))

// ---------------------------------------------------------------------------
// A factory that creates a mock ChildProcess EventEmitter
// ---------------------------------------------------------------------------
function makeMockChild(pid = 12345) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
    stdin: null
  }
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  child.stdin = null
  return child
}

import type { UseFn, Middleware } from "../../helpers"
import { registerNewSessionRoute, registerCreateAndSendRoute } from "../../routes/claude-new/sessionSpawner"

// ---------------------------------------------------------------------------
// Shared req/res factory
// ---------------------------------------------------------------------------
function createMockReqRes(method: string, body?: string) {
  const dataHandlers: ((chunk: Buffer) => void)[] = []
  const endHandlers: (() => void)[] = []

  const req = {
    method,
    url: "/",
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
    _getData: () => {
      try { return JSON.parse(endData || "{}") } catch { return {} }
    },
    _getStatus: () => statusCode,
  }

  const next = vi.fn()

  // Manually drive the req event emission
  const sendBody = () => {
    if (body) {
      for (const h of dataHandlers) h(Buffer.from(body))
    }
    for (const h of endHandlers) h()
  }

  return { req, res, next, sendBody }
}

function getHandler(registerFn: (use: UseFn) => void, path: string): Middleware {
  let captured: Middleware | undefined
  const use: UseFn = (p: string, handler: Middleware) => {
    if (p === path) captured = handler
  }
  registerFn(use)
  if (!captured) throw new Error(`No handler registered for ${path}`)
  return captured
}

// ---------------------------------------------------------------------------
// Tests: writeTempImageFiles / cleanupTempFiles (real fs, via importActual)
// ---------------------------------------------------------------------------
describe("writeTempImageFiles / cleanupTempFiles (real fs)", () => {
  it("writeTempImageFiles returns empty array for undefined input", async () => {
    const { writeTempImageFiles } = await vi.importActual<typeof import("../../helpers")>("../../helpers")
    const result = await writeTempImageFiles(undefined)
    expect(result).toEqual([])
  })

  it("writeTempImageFiles returns empty array for empty array input", async () => {
    const { writeTempImageFiles } = await vi.importActual<typeof import("../../helpers")>("../../helpers")
    const result = await writeTempImageFiles([])
    expect(result).toEqual([])
  })

  it("writeTempImageFiles writes a PNG temp file and returns its path", async () => {
    const { writeTempImageFiles } = await vi.importActual<typeof import("../../helpers")>("../../helpers")
    // 1x1 transparent PNG (base64)
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const paths = await writeTempImageFiles([{ data: pngBase64, mediaType: "image/png" }])
    expect(paths).toHaveLength(1)
    expect(paths[0]).toContain("cogpit-codex-image-")
    expect(paths[0]).toMatch(/\.png$/)
    await expect(access(paths[0])).resolves.toBeUndefined()
    await unlink(paths[0])
  })

  it("writeTempImageFiles handles jpeg mediaType → .jpg extension", async () => {
    const { writeTempImageFiles } = await vi.importActual<typeof import("../../helpers")>("../../helpers")
    const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")
    const paths = await writeTempImageFiles([{ data: jpegBase64, mediaType: "image/jpeg" }])
    expect(paths[0]).toMatch(/\.jpg$/)
    await unlink(paths[0])
  })

  it("cleanupTempFiles removes all listed files", async () => {
    const { cleanupTempFiles } = await vi.importActual<typeof import("../../helpers")>("../../helpers")
    const f1 = join(tmpdir(), `test-cleanup-${Date.now()}-a.txt`)
    const f2 = join(tmpdir(), `test-cleanup-${Date.now()}-b.txt`)
    await writeFile(f1, "hello")
    await writeFile(f2, "world")
    await expect(access(f1)).resolves.toBeUndefined()
    await expect(access(f2)).resolves.toBeUndefined()
    await cleanupTempFiles([f1, f2])
    await expect(access(f1)).rejects.toThrow()
    await expect(access(f2)).rejects.toThrow()
  })

  it("cleanupTempFiles ignores missing files (does not throw)", async () => {
    const { cleanupTempFiles } = await vi.importActual<typeof import("../../helpers")>("../../helpers")
    const nonexistent = join(tmpdir(), "this-file-does-not-exist-at-all.tmp")
    await expect(cleanupTempFiles([nonexistent])).resolves.toBeUndefined()
  })

  it("cleanupTempFiles is safe with empty array", async () => {
    const { cleanupTempFiles } = await vi.importActual<typeof import("../../helpers")>("../../helpers")
    await expect(cleanupTempFiles([])).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: registerNewSessionRoute — Claude (process-based) spawn scenarios
// ---------------------------------------------------------------------------
describe("registerNewSessionRoute (Claude)", () => {
  let handler: Middleware

  beforeEach(() => {
    vi.clearAllMocks()
    mockActiveProcesses.clear()
    mockPersistentSessions.clear()
    mockReaddir.mockResolvedValue([])
    // Default: stat rejects (session file not created yet)
    mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
    handler = getHandler(registerNewSessionRoute, "/api/new-session")
  })

  it("calls next for non-POST requests", () => {
    const { req, res, next } = createMockReqRes("GET")
    handler(req as never, res as never, next)
    expect(next).toHaveBeenCalled()
  })

  it("responds with 400 for missing dirName", async () => {
    const body = JSON.stringify({ message: "hello" })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)
    handler(req as never, res as never, next)
    sendBody()
    // Wait for the async req.on("end") handler
    await new Promise((r) => setTimeout(r, 20))
    expect(res._getStatus()).toBe(400)
    const data = res._getData()
    expect(data.error).toContain("required")
    expect(data.code).toBe("INVALID_REQUEST")
  })

  it("responds with 400 for missing message", async () => {
    const body = JSON.stringify({ dirName: "test-project" })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)
    handler(req as never, res as never, next)
    sendBody()
    await new Promise((r) => setTimeout(r, 20))
    expect(res._getStatus()).toBe(400)
    const data = res._getData()
    expect(data.code).toBe("INVALID_REQUEST")
  })

  // -------------------------------------------------------------------------
  // Scenario (a): process exits immediately (crash before session file)
  // -------------------------------------------------------------------------
  it("(a) crash: responds 500 when process exits non-zero before session file appears", async () => {
    const child = makeMockChild(1001)
    mockSpawn.mockReturnValue(child)

    const body = JSON.stringify({ dirName: "test-project", message: "hello" })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    sendBody()
    // Wait for async req.on("end") to run (sets up listeners etc.)
    await new Promise((r) => setTimeout(r, 20))

    // Process crashes
    child.emit("close", 1)
    await new Promise((r) => setTimeout(r, 20))

    expect(res._getStatus()).toBe(500)
    const data = res._getData()
    expect(data.error).toContain("exited with code 1")
  })

  it("(a) crash: activeProcesses entry is cleaned up after process exit", async () => {
    const child = makeMockChild(1002)
    mockSpawn.mockReturnValue(child)

    const body = JSON.stringify({ dirName: "test-project", message: "hello" })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    sendBody()
    await new Promise((r) => setTimeout(r, 20))

    // Should be set after spawn
    expect(mockActiveProcesses.has("test-session-uuid")).toBe(true)

    // Crash
    child.emit("close", 1)
    await new Promise((r) => setTimeout(r, 20))

    // close handler deletes from activeProcesses
    expect(mockActiveProcesses.has("test-session-uuid")).toBe(false)
  })

  it("(a) crash: stderr is forwarded as the error message", async () => {
    const child = makeMockChild(1003)
    mockSpawn.mockReturnValue(child)

    const body = JSON.stringify({ dirName: "test-project", message: "hello" })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    sendBody()
    await new Promise((r) => setTimeout(r, 20))

    child.stderr.emit("data", Buffer.from("permission denied"))
    child.emit("close", 1)
    await new Promise((r) => setTimeout(r, 20))

    const data = res._getData()
    expect(data.error).toBe("permission denied")
  })

  it("(a) success: responds 200 when process exits 0 and session file exists", async () => {
    const child = makeMockChild(1004)
    mockSpawn.mockReturnValue(child)
    mockStat.mockResolvedValue({}) // file exists

    const body = JSON.stringify({ dirName: "test-project", message: "hello" })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    sendBody()
    await new Promise((r) => setTimeout(r, 20))

    child.emit("close", 0)
    await new Promise((r) => setTimeout(r, 20))

    expect(res._getStatus()).toBe(200)
    const data = res._getData()
    expect(data.success).toBe(true)
    expect(data.sessionId).toBe("test-session-uuid")
  })

  // -------------------------------------------------------------------------
  // Scenario (b): process hangs until timeout
  // -------------------------------------------------------------------------
  it("(b) timeout: responds 500 and kills process after the 60s timeout fires", async () => {
    vi.useFakeTimers()
    try {
      const child = makeMockChild(2001)
      mockSpawn.mockReturnValue(child)

      const body = JSON.stringify({ dirName: "test-project", message: "hello" })
      const { req, res, next, sendBody } = createMockReqRes("POST", body)

      handler(req as never, res as never, next)
      sendBody()

      // Drain microtasks so the async req.on("end") handler runs and installs
      // the 60s setTimeout watchdog. advanceTimersByTimeAsync(0) flushes queued
      // microtasks between timer ticks (vitest 4.x behaviour).
      await vi.advanceTimersByTimeAsync(0)

      // Advance past the 60s timeout
      await vi.advanceTimersByTimeAsync(60_001)

      expect(child.kill).toHaveBeenCalledWith("SIGTERM")
      expect(res._getStatus()).toBe(500)
      const data = res._getData()
      expect(data.error).toContain("Timed out")
    } finally {
      vi.useRealTimers()
    }
  })

  it("(b) timeout: activeProcesses is populated before the timeout fires", async () => {
    vi.useFakeTimers()
    try {
      const child = makeMockChild(2002)
      mockSpawn.mockReturnValue(child)

      const body = JSON.stringify({ dirName: "test-project", message: "hello" })
      const { req, res, next, sendBody } = createMockReqRes("POST", body)

      handler(req as never, res as never, next)
      sendBody()
      await vi.advanceTimersByTimeAsync(0)

      // activeProcesses should be set after spawn completes
      expect(mockActiveProcesses.has("test-session-uuid")).toBe(true)

      // Advance to trigger timeout
      await vi.advanceTimersByTimeAsync(60_001)

      // Timed out → responded with error
      expect(res._getStatus()).toBe(500)
    } finally {
      vi.useRealTimers()
    }
  })

  // -------------------------------------------------------------------------
  // Spawn error (binary not found)
  // -------------------------------------------------------------------------
  it("spawn error: responds 500 when spawn emits an error event", async () => {
    const child = makeMockChild(3001)
    mockSpawn.mockReturnValue(child)
    mockFriendlySpawnError.mockReturnValue("Claude CLI is not installed")

    const body = JSON.stringify({ dirName: "test-project", message: "hello" })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    sendBody()
    await new Promise((r) => setTimeout(r, 20))

    const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException
    child.emit("error", err)
    await new Promise((r) => setTimeout(r, 20))

    expect(res._getStatus()).toBe(500)
    const data = res._getData()
    expect(data.error).toBe("Claude CLI is not installed")
  })
})

// ---------------------------------------------------------------------------
// Tests: registerCreateAndSendRoute (Codex path) — crash + cleanup scenarios
// ---------------------------------------------------------------------------
describe("registerCreateAndSendRoute (Codex) — crash and image cleanup", () => {
  let handler: Middleware

  beforeEach(() => {
    vi.clearAllMocks()
    mockActiveProcesses.clear()
    mockPersistentSessions.clear()
    mockReaddir.mockResolvedValue([])
    mockListCodexSessionFiles.mockResolvedValue([])
    mockFindNewestCodexSession.mockResolvedValue(null)
    mockWriteTempImageFiles.mockResolvedValue([])
    mockCleanupTempFiles.mockResolvedValue(undefined)

    // createInterface returns a minimal readline mock that never fires "line"
    mockCreateInterface.mockReturnValue({
      on: vi.fn(),
      close: vi.fn(),
    })

    handler = getHandler(registerCreateAndSendRoute, "/api/create-and-send")
  })

  it("calls next for non-POST requests", () => {
    const { req, res, next } = createMockReqRes("GET")
    handler(req as never, res as never, next)
    expect(next).toHaveBeenCalled()
  })

  it("responds with 400 for missing dirName", async () => {
    const body = JSON.stringify({ message: "hello" })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)
    handler(req as never, res as never, next)
    sendBody()
    await new Promise((r) => setTimeout(r, 20))
    expect(res._getStatus()).toBe(400)
    const data = res._getData()
    expect(data.code).toBe("INVALID_REQUEST")
  })

  // -------------------------------------------------------------------------
  // Scenario (a): Codex spawned process crashes immediately (no session identity)
  // -------------------------------------------------------------------------
  it("(a) codex crash: responds 500 and Maps stay empty when process crashes before identity", async () => {
    vi.useFakeTimers()
    try {
      const child = makeMockChild(4001)
      mockSpawn.mockReturnValue(child)

      const body = JSON.stringify({
        dirName: "codex:/tmp/myproject",
        message: "hello",
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", body)

      handler(req as never, res as never, next)
      sendBody()
      await vi.advanceTimersByTimeAsync(0)

      // Crash immediately — no session identity was produced
      child.emit("close", 1)
      await vi.advanceTimersByTimeAsync(0)

      // Settle the waitForCodexSession promise by advancing past its 15s polling timeout
      await vi.advanceTimersByTimeAsync(15_001)
      await vi.advanceTimersByTimeAsync(0)

      expect(res._getStatus()).toBe(500)
      const data = res._getData()
      expect(data.error).toContain("exited with code 1")

      // Neither Map should have entries since session was never registered
      expect(mockActiveProcesses.size).toBe(0)
      expect(mockPersistentSessions.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // -------------------------------------------------------------------------
  // Scenario (c): temp image file cleanup after crash
  // -------------------------------------------------------------------------
  it("(c) image cleanup: cleanupTempFiles called with image paths after process crash", async () => {
    vi.useFakeTimers()
    try {
      const child = makeMockChild(4002)
      mockSpawn.mockReturnValue(child)

      const imagePaths = ["/tmp/cogpit-image-1.png", "/tmp/cogpit-image-2.png"]
      mockWriteTempImageFiles.mockResolvedValue(imagePaths)

      const body = JSON.stringify({
        dirName: "codex:/tmp/myproject",
        message: "hello",
        images: [
          { data: "abc", mediaType: "image/png" },
          { data: "def", mediaType: "image/png" },
        ],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", body)

      handler(req as never, res as never, next)
      sendBody()
      await vi.advanceTimersByTimeAsync(0)

      child.emit("close", 1)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(15_001)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockCleanupTempFiles).toHaveBeenCalledWith(imagePaths)
    } finally {
      vi.useRealTimers()
    }
  })

  it("(c) image cleanup: cleanupTempFiles called even on spawn error event", async () => {
    vi.useFakeTimers()
    try {
      const child = makeMockChild(4003)
      mockSpawn.mockReturnValue(child)
      mockFriendlySpawnError.mockReturnValue("Codex not installed")

      const imagePaths = ["/tmp/cogpit-image-x.png"]
      mockWriteTempImageFiles.mockResolvedValue(imagePaths)

      const body = JSON.stringify({
        dirName: "codex:/tmp/myproject",
        message: "hello",
        images: [{ data: "abc", mediaType: "image/png" }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", body)

      handler(req as never, res as never, next)
      sendBody()
      await vi.advanceTimersByTimeAsync(0)

      const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException
      child.emit("error", err)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockCleanupTempFiles).toHaveBeenCalledWith(imagePaths)
      expect(res._getStatus()).toBe(500)
    } finally {
      vi.useRealTimers()
    }
  })
})
