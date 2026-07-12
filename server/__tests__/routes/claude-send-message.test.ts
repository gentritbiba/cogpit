// @vitest-environment node
/**
 * Tests for /api/send-message (routes/claude.ts) — SDK resume path.
 *
 * Newer Claude Code versions scope `--resume` to the project directory
 * derived from cwd, so resuming from the wrong cwd fails with
 * error_during_execution. When the client omits `cwd`, the route must
 * derive it from the session's JSONL metadata instead of falling back
 * straight to homedir().
 */

import { EventEmitter } from "node:events"
import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockActiveProcesses,
  mockPersistentSessions,
  mockSdkSessions,
  mockFindJsonlPath,
  mockGetSessionMeta,
  mockResumeSDKSession,
  mockGetAgentKind,
  mockSpawn,
  mockCodexAppServer,
} = vi.hoisted(() => ({
  mockActiveProcesses: new Map<string, unknown>(),
  mockPersistentSessions: new Map<string, unknown>(),
  mockSdkSessions: new Map<string, unknown>(),
  mockFindJsonlPath: vi.fn(),
  mockGetSessionMeta: vi.fn(),
  mockResumeSDKSession: vi.fn(),
  mockGetAgentKind: vi.fn(() => "claude"),
  mockSpawn: vi.fn(),
  mockCodexAppServer: {
    start: vi.fn(),
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    interruptTurn: vi.fn(),
    getActiveTurnId: vi.fn(),
    call: vi.fn(),
  },
}))

vi.mock("../../helpers", () => ({
  activeProcesses: mockActiveProcesses,
  persistentSessions: mockPersistentSessions,
  findJsonlPath: mockFindJsonlPath,
  spawn: mockSpawn,
  homedir: () => "/Users/me",
  buildCodexPermArgs: vi.fn(() => [
    "--sandbox",
    "workspace-write",
    "-c",
    'approval_policy="never"',
  ]),
  buildCodexModelArgs: vi.fn(() => []),
  buildCodexEffortArgs: vi.fn(() => []),
  buildCodexFastModeArgs: vi.fn(() => []),
  writeTempImageFiles: vi.fn().mockResolvedValue([]),
  cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
  getAgentKindFromSessionPath: mockGetAgentKind,
  getSessionMeta: mockGetSessionMeta,
  friendlySpawnError: vi.fn((err: Error) => err.message),
}))

vi.mock("../../sdk-session", () => ({
  sdkSessions: mockSdkSessions,
  sendSDKMessage: vi.fn(),
  resumeSDKSession: mockResumeSDKSession,
  attachSubagentWatcher: vi.fn(),
}))

vi.mock("../../codex-app-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../codex-app-server")>()
  return { ...actual, codexAppServer: mockCodexAppServer }
})

import type { UseFn, Middleware } from "../../helpers"
import { registerClaudeRoutes } from "../../routes/claude"

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
  }

  const next = vi.fn()

  const sendBody = () => {
    if (body) for (const h of dataHandlers) h(Buffer.from(body))
    for (const h of endHandlers) h()
  }

  return { req, res, next, sendBody }
}

function getHandler(path: string): Middleware {
  let captured: Middleware | undefined
  const use: UseFn = (p: string, handler: Middleware) => {
    if (p === path) captured = handler
  }
  registerClaudeRoutes(use)
  if (!captured) throw new Error(`No handler registered for ${path}`)
  return captured
}

async function postSendMessage(body: Record<string, unknown>) {
  const handler = getHandler("/api/send-message")
  const { req, res, next, sendBody } = createMockReqRes("POST", JSON.stringify(body))
  handler(req as never, res as never, next)
  sendBody()
  // let the async req.on("end") handler run
  await vi.waitFor(() => {
    expect(mockResumeSDKSession).toHaveBeenCalled()
  })
  return { res }
}

function makeMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: null
    kill: ReturnType<typeof vi.fn>
  }
  child.pid = 7001
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = null
  child.kill = vi.fn()
  return child
}

async function postCodexMessage(body: Record<string, unknown>) {
  const handler = getHandler("/api/send-message")
  const { req, res, next, sendBody } = createMockReqRes("POST", JSON.stringify(body))
  handler(req as never, res as never, next)
  sendBody()
  return { res }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockActiveProcesses.clear()
  mockPersistentSessions.clear()
  mockSdkSessions.clear()
  mockGetAgentKind.mockReturnValue("claude")
  mockSpawn.mockReset()
  mockCodexAppServer.start.mockResolvedValue({})
  mockCodexAppServer.getActiveTurnId.mockReturnValue(undefined)
  mockCodexAppServer.resumeThread.mockResolvedValue({
    thread: { id: "sess-1", turns: [] },
  })
  mockCodexAppServer.startTurn.mockResolvedValue({ turn: { id: "turn-new" } })
  mockCodexAppServer.steerTurn.mockResolvedValue({ turnId: "turn-active" })
  mockCodexAppServer.call.mockResolvedValue({})
  mockResumeSDKSession.mockReturnValue({
    sessionId: "sess-1",
    jsonlPath: null,
    onResult: null,
  })
})

describe("/api/send-message SDK resume cwd", () => {
  it("derives cwd from session metadata when the request omits cwd", async () => {
    mockFindJsonlPath.mockResolvedValue("/Users/me/.claude/projects/-Users-me-proj/sess-1.jsonl")
    mockGetSessionMeta.mockResolvedValue({ cwd: "/Users/me/proj" })

    await postSendMessage({ sessionId: "sess-1", message: "hi" })

    expect(mockResumeSDKSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/Users/me/proj" }),
    )
  })

  it("prefers an explicit cwd from the request over session metadata", async () => {
    mockFindJsonlPath.mockResolvedValue("/Users/me/.claude/projects/-Users-me-proj/sess-1.jsonl")
    mockGetSessionMeta.mockResolvedValue({ cwd: "/Users/me/proj" })

    await postSendMessage({ sessionId: "sess-1", message: "hi", cwd: "/explicit/dir" })

    expect(mockResumeSDKSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/explicit/dir" }),
    )
  })

  it("falls back to homedir when there is no session metadata", async () => {
    mockFindJsonlPath.mockResolvedValue(null)
    mockGetSessionMeta.mockResolvedValue(null)

    await postSendMessage({ sessionId: "sess-1", message: "hi" })

    expect(mockResumeSDKSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/Users/me" }),
    )
  })
})

describe("/api/send-message Codex app-server", () => {
  beforeEach(() => {
    mockGetAgentKind.mockReturnValue("codex")
    mockFindJsonlPath.mockResolvedValue(
      "/Users/me/.codex/sessions/2026/07/12/rollout-sess-1.jsonl",
    )
    mockGetSessionMeta.mockResolvedValue({ cwd: "/Users/me/proj" })
  })

  it("resumes an idle thread and starts a turn", async () => {
    const { res } = await postCodexMessage({
      sessionId: "sess-1",
      message: "continue",
      model: "gpt-5.6-terra",
      effort: "high",
      fastMode: true,
    })

    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(mockCodexAppServer.resumeThread).toHaveBeenCalledWith(
      "sess-1",
      expect.objectContaining({
        path: "/Users/me/.codex/sessions/2026/07/12/rollout-sess-1.jsonl",
        cwd: "/Users/me/proj",
        model: "gpt-5.6-terra",
        serviceTier: "priority",
      }),
    )
    expect(mockCodexAppServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "sess-1",
      effort: "high",
      input: [{ type: "text", text: "continue", text_elements: [] }],
    }))
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(res._getData()).toEqual({ success: true })
  })

  it("steers the current native turn instead of returning a conflict", async () => {
    mockCodexAppServer.getActiveTurnId.mockReturnValue("turn-active")
    const { res } = await postCodexMessage({
      sessionId: "sess-1",
      message: "focus on tests",
    })

    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(mockCodexAppServer.resumeThread).not.toHaveBeenCalled()
    expect(mockCodexAppServer.steerTurn).toHaveBeenCalledWith(
      "sess-1",
      [{ type: "text", text: "focus on tests", text_elements: [] }],
      "turn-active",
    )
    expect(mockCodexAppServer.startTurn).not.toHaveBeenCalled()
    expect(res._getData()).toEqual({ success: true })
  })

  it("falls back to codex exec resume when app-server is unavailable", async () => {
    mockCodexAppServer.start.mockRejectedValue(
      new Error("Codex app-server unavailable"),
    )
    const child = makeMockChild()
    mockSpawn.mockReturnValue(child)

    await postCodexMessage({ sessionId: "sess-1", message: "legacy path" })
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled())

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      [
        "exec",
        "--sandbox",
        "workspace-write",
        "-c",
        'approval_policy="never"',
        "resume",
        "--json",
        "sess-1",
        "legacy path",
      ],
      expect.objectContaining({ cwd: "/Users/me/proj" }),
    )
  })
})
