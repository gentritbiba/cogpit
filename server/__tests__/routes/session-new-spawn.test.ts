// @vitest-environment node
/**
 * Tests for session spawn failure scenarios in session-new/sessionSpawner.ts
 *
 * Coverage:
 *  - writeTempImageFiles / cleanupTempFiles helpers (real fs, direct unit tests)
 *  - registerCreateAndSendRoute (Codex): crash before session identity → Maps stay empty
 *  - registerCreateAndSendRoute (Codex): temp image files cleaned up on crash / error
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeFile, unlink, access } from "node:fs/promises"
import { descriptorFor } from "../../../shared/session/agent-descriptors"

vi.mock("../../browser/agentEnv", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  browserShimInstalled: () => false,
}))

// ---------------------------------------------------------------------------
// Hoisted mutable Maps and spy fns so vi.mock factory can reference them
// ---------------------------------------------------------------------------
const {
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
  mockCodexAppServer,
  mockCopilotRuntime,
} = vi.hoisted(() => {
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
  const mockCodexAppServer = {
    start: vi.fn(),
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    interruptTurn: vi.fn(),
    getActiveTurnId: vi.fn(),
    call: vi.fn(),
  }
  const mockCopilotRuntime = {
    createSession: vi.fn(),
    setSessionName: vi.fn(),
    setPermissionMode: vi.fn(),
    send: vi.fn().mockResolvedValue("message-1"),
    isSessionActive: vi.fn().mockReturnValue(true),
    destroySession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue({ success: true }),
  }
  return {
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
    mockCodexAppServer,
    mockCopilotRuntime,
  }
})

// ---------------------------------------------------------------------------
// Mock ../../helpers
// ---------------------------------------------------------------------------
// The process registry stays real: the runtimes' teardown helpers close over
// its maps, so a stubbed copy would make every registration assertion vacuous.
vi.mock("../../agents/spawnError", () => ({
  friendlySpawnError: mockFriendlySpawnError,
}))

vi.mock("../../agents/tempImages", () => ({
  writeTempImageFiles: mockWriteTempImageFiles,
  cleanupTempFiles: mockCleanupTempFiles,
}))

vi.mock("../../helpers", async () => {
  const registry = await vi.importActual<typeof import("../../processRegistry")>(
    "../../processRegistry",
  )
  return ({
  activeProcesses: registry.activeProcesses,
  persistentSessions: registry.persistentSessions,
  dirs: { PROJECTS_DIR: "/tmp/test-projects" },
  isWithinDir: vi.fn(() => true),
  spawn: mockSpawn,
  stat: mockStat,
  readFile: mockReadFile,
  open: vi.fn(),
  readdir: mockReaddir,
  join: (...parts: string[]) => parts.join("/"),
  randomUUID: vi.fn(() => "test-session-uuid"),
  createInterface: mockCreateInterface,
  getSessionMeta: vi.fn().mockResolvedValue(null),
  homedir: () => "/Users/me",
  unlink: vi.fn().mockResolvedValue(undefined),
})
})

vi.mock("../../sessionPaths", () => ({
  findJsonlPath: vi.fn().mockResolvedValue(null),
  findNewestCodexSessionForCwd: mockFindNewestCodexSession,
}))

vi.mock("../../agents", () => {
  const roots: Record<string, string> = {
    codex: "/tmp/.codex/sessions",
    copilot: "/tmp/.copilot/session-state",
    claude: "/tmp/test-projects",
  }
  return {
    storeFor: (kind: string) => ({
      kind,
      sessionsRoot: () => roots[kind],
      listSessionFiles: mockListCodexSessionFiles,
    }),
    storeForPath: (filePath: string | null) => {
      if (!filePath) return null
      const kind = Object.keys(roots).find((key) => filePath.startsWith(`${roots[key]}/`))
      return kind ? { kind } : null
    },
  }
})

const CODEX_DIR_NAME = descriptorFor("codex").dirName.encode("/tmp/myproject")
const COPILOT_DIR_NAME = descriptorFor("copilot").dirName.encode("/tmp/copilot-project")

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

vi.mock("../../agents/codexAppServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/codexAppServer")>()
  return { ...actual, codexAppServer: mockCodexAppServer }
})

vi.mock("../../agents/copilotTransport", () => ({ copilotRuntime: mockCopilotRuntime }))

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
import { createSDKSession } from "../../sdk-session"
import {
  activeProcesses as mockActiveProcesses,
  persistentSessions as mockPersistentSessions,
} from "../../processRegistry"
import { registerCreateAndSendRoute } from "../../routes/session-new/sessionSpawner"

const mockedCreateSDKSession = vi.mocked(createSDKSession)

// ---------------------------------------------------------------------------
// Shared req/res factory
// ---------------------------------------------------------------------------
function createMockReqRes(method: string, body?: string) {
  const dataHandlers: ((chunk: Buffer) => void)[] = []
  const endHandlers: Array<() => void | Promise<void>> = []

  const req = {
    method,
    url: "/",
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      if (event === "data") dataHandlers.push(handler as (chunk: Buffer) => void)
      if (event === "end") endHandlers.push(handler as () => void | Promise<void>)
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
  const sendBody = async () => {
    if (body) {
      for (const h of dataHandlers) h(Buffer.from(body))
    }
    for (const h of endHandlers) await h()
    await drainBodyParse()
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
/**
 * Drain the microtask queue that withJsonBody parses on. Deliberately not
 * setImmediate: several tests here run with fake timers, which never fire it.
 * readJsonBody settles through promises only, so yielding is enough.
 */
async function drainBodyParse() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe("writeTempImageFiles / cleanupTempFiles (real fs)", () => {
  it("writeTempImageFiles returns empty array for undefined input", async () => {
    const { writeTempImageFiles } = await vi.importActual<typeof import("../../agents/tempImages")>("../../agents/tempImages")
    const result = await writeTempImageFiles(undefined)
    expect(result).toEqual([])
  })

  it("writeTempImageFiles returns empty array for empty array input", async () => {
    const { writeTempImageFiles } = await vi.importActual<typeof import("../../agents/tempImages")>("../../agents/tempImages")
    const result = await writeTempImageFiles([])
    expect(result).toEqual([])
  })

  it("writeTempImageFiles writes a PNG temp file and returns its path", async () => {
    const { writeTempImageFiles } = await vi.importActual<typeof import("../../agents/tempImages")>("../../agents/tempImages")
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
    const { writeTempImageFiles } = await vi.importActual<typeof import("../../agents/tempImages")>("../../agents/tempImages")
    const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")
    const paths = await writeTempImageFiles([{ data: jpegBase64, mediaType: "image/jpeg" }])
    expect(paths[0]).toMatch(/\.jpg$/)
    await unlink(paths[0])
  })

  it("cleanupTempFiles removes all listed files", async () => {
    const { cleanupTempFiles } = await vi.importActual<typeof import("../../agents/tempImages")>("../../agents/tempImages")
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
    const { cleanupTempFiles } = await vi.importActual<typeof import("../../agents/tempImages")>("../../agents/tempImages")
    const nonexistent = join(tmpdir(), "this-file-does-not-exist-at-all.tmp")
    await expect(cleanupTempFiles([nonexistent])).resolves.toBeUndefined()
  })

  it("cleanupTempFiles is safe with empty array", async () => {
    const { cleanupTempFiles } = await vi.importActual<typeof import("../../agents/tempImages")>("../../agents/tempImages")
    await expect(cleanupTempFiles([])).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: registerCreateAndSendRoute (Claude path) — exact cwd validation
// ---------------------------------------------------------------------------
describe("registerCreateAndSendRoute (Claude cwd)", () => {
  let handler: Middleware

  beforeEach(() => {
    vi.clearAllMocks()
    mockStat.mockResolvedValue({})
    mockReadFile.mockRejectedValue(new Error("not written yet"))
    handler = getHandler(registerCreateAndSendRoute, "/api/create-and-send")
  })

  it("uses an explicit cwd instead of reconstructing a hyphenated path", async () => {
    const body = JSON.stringify({
      dirName: "-tmp-my-project",
      cwd: "/tmp/my-project",
      message: "hello",
    })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    await sendBody()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(res._getStatus()).toBe(200)
    expect(mockedCreateSDKSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/my-project" }),
    )
    expect(mockReaddir).not.toHaveBeenCalled()
  })

  it.each([
    ["relative cwd", "tmp/my-project"],
    ["NUL-containing cwd", "/tmp/my\0project"],
  ])("rejects an invalid %s", async (_label, cwd) => {
    const body = JSON.stringify({ dirName: "-tmp-my-project", cwd, message: "hello" })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    await sendBody()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(res._getStatus()).toBe(400)
    expect(res._getData().code).toBe("INVALID_REQUEST")
    expect(mockedCreateSDKSession).not.toHaveBeenCalled()
  })

  it("rejects a cwd whose Claude encoding does not match dirName", async () => {
    const body = JSON.stringify({
      dirName: "-tmp-my-project",
      cwd: "/tmp/other-project",
      message: "hello",
    })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    await sendBody()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(res._getStatus()).toBe(400)
    expect(res._getData().code).toBe("INVALID_REQUEST")
    expect(mockedCreateSDKSession).not.toHaveBeenCalled()
  })
  /**
   * A pasted screenshot is base64 in the JSON body, and the client compresses
   * only down to 3.5 MB (useImageUpload.ts). This route once inherited
   * readJsonBody's 64 KB default, so every real image 413'd here while the same
   * image sent to /api/send-message went through.
   */
  it("accepts a pasted image far larger than the default 64 KB body cap", async () => {
    const images = [{ data: "A".repeat(200_000), mediaType: "image/png" }]
    const body = JSON.stringify({
      dirName: "-tmp-my-project",
      cwd: "/tmp/my-project",
      message: "look at this",
      images,
    })
    expect(body.length).toBeGreaterThan(64 * 1024)
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    await sendBody()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(res._getStatus()).toBe(200)
    expect(mockedCreateSDKSession).toHaveBeenCalledWith(
      expect.objectContaining({ images }),
    )
  })
})

describe("registerCreateAndSendRoute (Copilot)", () => {
  let handler: Middleware

  beforeEach(() => {
    vi.clearAllMocks()
    mockCopilotRuntime.send.mockResolvedValue("message-1")
    mockCopilotRuntime.isSessionActive.mockReturnValue(true)
    mockReadFile.mockResolvedValue([
      JSON.stringify({
        type: "session.start",
        data: { sessionId: "test-session-uuid", context: { cwd: "/tmp/copilot-project" } },
      }),
      JSON.stringify({ type: "user.message", data: { content: "look at this" } }),
    ].join("\n"))
    handler = getHandler(registerCreateAndSendRoute, "/api/create-and-send")
  })

  it("creates a headless session with model, effort, plan mode, and blob images", async () => {
    const body = JSON.stringify({
      dirName: COPILOT_DIR_NAME,
      message: "look at this",
      model: "claude-sonnet-4.6",
      effort: "high",
      name: "  Ship \"Copilot\" support  ",
      permissions: { mode: "plan" },
      images: [{ data: "base64-image", mediaType: "image/png" }],
    })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    await sendBody()
    await drainBodyParse()

    expect(mockCopilotRuntime.createSession).toHaveBeenCalledWith({
      sessionId: "test-session-uuid",
      workingDirectory: "/tmp/copilot-project",
      model: "claude-sonnet-4.6",
      reasoningEffort: "high",
    })
    expect(mockCopilotRuntime.setSessionName).toHaveBeenCalledWith(
      "test-session-uuid",
      "Ship  Copilot  support",
    )
    expect(mockCopilotRuntime.setPermissionMode).toHaveBeenCalledWith("test-session-uuid", false)
    expect(mockCopilotRuntime.send).toHaveBeenCalledWith("test-session-uuid", {
      prompt: "look at this",
      agentMode: "plan",
      attachments: [{
        type: "blob",
        data: "base64-image",
        mimeType: "image/png",
        displayName: "image-1",
      }],
    })
    expect(res._getData()).toMatchObject({
      success: true,
      dirName: COPILOT_DIR_NAME,
      fileName: "test-session-uuid/events.jsonl",
      sessionId: "test-session-uuid",
    })
  })

  it("enables Copilot full access before sending", async () => {
    const body = JSON.stringify({
      dirName: COPILOT_DIR_NAME,
      message: "ship it",
      permissions: { mode: "bypassPermissions" },
    })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    await sendBody()
    await drainBodyParse()

    expect(mockCopilotRuntime.setPermissionMode).toHaveBeenCalledWith("test-session-uuid", true)
    expect(mockCopilotRuntime.send).toHaveBeenCalledWith("test-session-uuid", {
      prompt: "ship it",
      agentMode: "interactive",
    })
    expect(mockCopilotRuntime.setPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(
      mockCopilotRuntime.send.mock.invocationCallOrder[0],
    )
    expect(res._getStatus()).toBe(200)
  })

  it("deletes a new Copilot session when its first send fails", async () => {
    mockCopilotRuntime.send.mockRejectedValueOnce(new Error("quota exceeded"))
    const body = JSON.stringify({
      dirName: COPILOT_DIR_NAME,
      message: "ship it",
    })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    await sendBody()
    await drainBodyParse()

    expect(mockCopilotRuntime.destroySession).toHaveBeenCalledWith("test-session-uuid")
    expect(mockCopilotRuntime.deleteSession).toHaveBeenCalledWith("test-session-uuid")
    expect(res._getStatus()).toBe(500)
    expect(res._getData()).toMatchObject({ error: "quota exceeded" })
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
    mockCodexAppServer.start.mockRejectedValue(new Error("Codex app-server unavailable"))

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
    await sendBody()
    await new Promise((r) => setTimeout(r, 20))
    expect(res._getStatus()).toBe(400)
    const data = res._getData()
    expect(data.code).toBe("INVALID_REQUEST")
  })

  it("shares the app-server startup path while preserving image input", async () => {
    mockCodexAppServer.start.mockResolvedValue({})
    mockCodexAppServer.startThread.mockResolvedValue({
      thread: {
        id: "thread-create-and-send",
        path: "/tmp/.codex/sessions/2026/07/21/rollout-thread-create-and-send.jsonl",
        turns: [],
      },
    })
    mockCodexAppServer.startTurn.mockResolvedValue({ turn: { id: "turn-create-and-send" } })
    mockReadFile.mockResolvedValue("native create-and-send rollout")

    const body = JSON.stringify({
      dirName: CODEX_DIR_NAME,
      message: "describe this",
      images: [{ data: "ZmFrZQ==", mediaType: "image/png" }],
      permissions: { mode: "plan" },
    })
    const { req, res, next, sendBody } = createMockReqRes("POST", body)

    handler(req as never, res as never, next)
    await sendBody()

    expect(mockSpawn).not.toHaveBeenCalled()
    expect(mockWriteTempImageFiles).not.toHaveBeenCalled()
    expect(mockCodexAppServer.startThread).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/myproject",
      approvalPolicy: "never",
      sandbox: "read-only",
    }))
    expect(mockCodexAppServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-create-and-send",
      input: [
        { type: "text", text: "describe this", text_elements: [] },
        { type: "image", url: "data:image/png;base64,ZmFrZQ==" },
      ],
    }))
    expect(res._getData()).toEqual({
      success: true,
      dirName: CODEX_DIR_NAME,
      fileName: "2026/07/21/rollout-thread-create-and-send.jsonl",
      sessionId: "thread-create-and-send",
      initialContent: "native create-and-send rollout",
    })
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
        dirName: CODEX_DIR_NAME,
        message: "hello",
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", body)

      handler(req as never, res as never, next)
      await sendBody()
      await vi.advanceTimersByTimeAsync(0)

      // Crash immediately — no session identity was produced
      child.emit("close", 1)
      await vi.advanceTimersByTimeAsync(0)

      // Settle the waitForCodexSession promise by advancing past its 15s polling timeout
      await vi.advanceTimersByTimeAsync(60_001)
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
        dirName: CODEX_DIR_NAME,
        message: "hello",
        images: [
          { data: "abc", mediaType: "image/png" },
          { data: "def", mediaType: "image/png" },
        ],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", body)

      handler(req as never, res as never, next)
      await sendBody()
      await vi.advanceTimersByTimeAsync(0)

      child.emit("close", 1)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60_001)
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
        dirName: CODEX_DIR_NAME,
        message: "hello",
        images: [{ data: "abc", mediaType: "image/png" }],
      })
      const { req, res, next, sendBody } = createMockReqRes("POST", body)

      handler(req as never, res as never, next)
      await sendBody()
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
