// @vitest-environment node
/**
 * Tests for /api/send-message (routes/session-send.ts).
 *
 * Newer Claude Code versions scope `--resume` to the project directory
 * derived from cwd, so resuming from the wrong cwd fails with
 * error_during_execution. When the client omits `cwd`, the route must
 * derive it from the session's JSONL metadata instead of falling back
 * straight to homedir().
 */

import { EventEmitter } from "node:events"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../browser/agentEnv", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  browserShimInstalled: () => false,
}))

const {
  mockActiveProcesses,
  mockPersistentSessions,
  mockSdkSessions,
  mockFindJsonlPath,
  mockGetSessionMeta,
  mockSendSDKMessage,
  mockResumeSDKSession,
  mockSpawn,
  mockCodexAppServer,
  mockCopilotRuntime,
} = vi.hoisted(() => ({
  mockActiveProcesses: new Map<string, unknown>(),
  mockPersistentSessions: new Map<string, unknown>(),
  mockSdkSessions: new Map<string, unknown>(),
  mockFindJsonlPath: vi.fn(),
  mockGetSessionMeta: vi.fn(),
  mockSendSDKMessage: vi.fn(),
  mockResumeSDKSession: vi.fn(),
  mockSpawn: vi.fn(),
  mockCodexAppServer: {
    start: vi.fn(),
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    startTurn: vi.fn(),
    steerTurn: vi.fn(),
    interruptTurn: vi.fn(),
    getActiveTurnId: vi.fn(),
    listApprovalThreadIds: vi.fn(() => []),
    call: vi.fn(),
  },
  mockCopilotRuntime: {
    isSessionActive: vi.fn(),
    isTurnActive: vi.fn(),
    getPendingPermissions: vi.fn(() => []),
    getPendingUserInputs: vi.fn(() => []),
    resumeSession: vi.fn(),
    setModel: vi.fn(),
    setReasoningEffort: vi.fn(),
    setPermissionMode: vi.fn(),
    send: vi.fn().mockResolvedValue("message-1"),
  },
}))

vi.mock("../../processRegistry", () => ({
  activeProcesses: mockActiveProcesses,
  persistentSessions: mockPersistentSessions,
  terminateTrackedSession: vi.fn(() => false),
  killTrackedProcesses: vi.fn(() => 0),
}))

vi.mock("../../agents/spawnError", () => ({
  friendlySpawnError: vi.fn((err: Error) => err.message),
}))
vi.mock("../../agents/tempImages", () => ({
  writeTempImageFiles: vi.fn().mockResolvedValue([]),
  cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../../helpers", () => ({
  activeProcesses: mockActiveProcesses,
  persistentSessions: mockPersistentSessions,
  spawn: mockSpawn,
  join: (...parts: string[]) => parts.join("/"),
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  createInterface: vi.fn(() => ({ on: vi.fn() })),
  homedir: () => "/Users/me",
  getSessionMeta: mockGetSessionMeta,
}))

vi.mock("../../sessionPaths", () => ({
  findJsonlPath: mockFindJsonlPath,
  findNewestCodexSessionForCwd: vi.fn().mockResolvedValue(null),
}))

// The session's agent is decided by whose storage its transcript sits in.
vi.mock("../../agents", () => {
  const roots: Record<string, string> = {
    claude: "/Users/me/.claude/projects",
    codex: "/Users/me/.codex/sessions",
    copilot: "/Users/me/.copilot/session-state",
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

vi.mock("../../sdk-session", async (importOriginal) => {
  // Pass the REAL isSDKQueryLive through: re-implementing it here would let the
  // route keep passing if the predicate ever regressed.
  const actual = await importOriginal<typeof import("../../sdk-session")>()
  return {
    sdkSessions: mockSdkSessions,
    sendSDKMessage: mockSendSDKMessage,
    resumeSDKSession: mockResumeSDKSession,
    attachSubagentWatcher: vi.fn(),
    isSDKQueryLive: actual.isSDKQueryLive,
  }
})

vi.mock("../../agents/codexAppServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/codexAppServer")>()
  return { ...actual, codexAppServer: mockCodexAppServer }
})

vi.mock("../../agents/copilotTransport", () => ({ copilotRuntime: mockCopilotRuntime }))

import type { UseFn, Middleware } from "../../helpers"
import { registerSessionSendRoutes } from "../../routes/session-send"

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
  registerSessionSendRoutes(use)
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
  mockSpawn.mockReset()
  // The agent is derived from the transcript's location, so each test says
  // where the session lives rather than declaring its kind directly.
  mockFindJsonlPath.mockResolvedValue(null)
  mockSendSDKMessage.mockReturnValue(null)
  mockCodexAppServer.start.mockResolvedValue({})
  mockCodexAppServer.getActiveTurnId.mockReturnValue(undefined)
  mockCodexAppServer.resumeThread.mockResolvedValue({
    thread: { id: "sess-1", turns: [] },
  })
  mockCodexAppServer.startTurn.mockResolvedValue({ turn: { id: "turn-new" } })
  mockCodexAppServer.steerTurn.mockResolvedValue({ turnId: "turn-active" })
  mockCodexAppServer.call.mockResolvedValue({})
  mockCopilotRuntime.isSessionActive.mockReturnValue(false)
  mockCopilotRuntime.isTurnActive.mockReturnValue(false)
  mockCopilotRuntime.getPendingPermissions.mockReturnValue([])
  mockCopilotRuntime.getPendingUserInputs.mockReturnValue([])
  mockCodexAppServer.listApprovalThreadIds.mockReturnValue([])
  mockCopilotRuntime.send.mockResolvedValue("message-1")
  mockResumeSDKSession.mockReturnValue({
    sessionId: "sess-1",
    jsonlPath: null,
    onResult: null,
  })
})

describe("/api/send-message Copilot runtime", () => {
  beforeEach(() => {
    mockFindJsonlPath.mockResolvedValue(
      "/Users/me/.copilot/session-state/sess-1/events.jsonl",
    )
    mockGetSessionMeta.mockResolvedValue({ cwd: "/Users/me/proj" })
  })

  it("resumes a durable session and sends plan-mode image input", async () => {
    const handler = getHandler("/api/send-message")
    const { req, res, next, sendBody } = createMockReqRes("POST", JSON.stringify({
      sessionId: "sess-1",
      message: "inspect this",
      model: "claude-sonnet-4.6",
      effort: "high",
      permissions: { mode: "plan" },
      images: [{ data: "base64-image", mediaType: "image/png" }],
    }))
    handler(req as never, res as never, next)
    sendBody()

    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(mockCopilotRuntime.resumeSession).toHaveBeenCalledWith("sess-1", {
      workingDirectory: "/Users/me/proj",
      model: "claude-sonnet-4.6",
      reasoningEffort: "high",
    })
    expect(mockCopilotRuntime.setPermissionMode).toHaveBeenCalledWith("sess-1", false)
    expect(mockCopilotRuntime.send).toHaveBeenCalledWith("sess-1", {
      prompt: "inspect this",
      agentMode: "plan",
      attachments: [{
        type: "blob",
        data: "base64-image",
        mimeType: "image/png",
        displayName: "image-1",
      }],
    })
    expect(res._getData()).toEqual({ success: true })
  })

  it("accepts a pasted image larger than the default JSON body cap", async () => {
    const imageData = "A".repeat(200_000)
    const body = JSON.stringify({
      sessionId: "sess-1",
      message: "inspect this",
      images: [{ data: imageData, mediaType: "image/png" }],
    })
    expect(body.length).toBeGreaterThan(64 * 1024)

    const handler = getHandler("/api/send-message")
    const { req, res, next, sendBody } = createMockReqRes("POST", body)
    handler(req as never, res as never, next)
    sendBody()

    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(res.statusCode).toBe(200)
    expect(mockCopilotRuntime.send).toHaveBeenCalledWith("sess-1", expect.objectContaining({
      attachments: [expect.objectContaining({ data: imageData })],
    }))
  })

  it("updates a loaded session in place and enables full access", async () => {
    mockCopilotRuntime.isSessionActive.mockReturnValue(true)
    const handler = getHandler("/api/send-message")
    const { req, res, next, sendBody } = createMockReqRes("POST", JSON.stringify({
      sessionId: "sess-1",
      message: "continue",
      model: "gpt-5.4",
      effort: "medium",
      permissions: { mode: "bypassPermissions" },
    }))
    handler(req as never, res as never, next)
    sendBody()

    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(mockCopilotRuntime.resumeSession).not.toHaveBeenCalled()
    expect(mockCopilotRuntime.setModel).toHaveBeenCalledWith("sess-1", "gpt-5.4", "medium")
    expect(mockCopilotRuntime.setPermissionMode).toHaveBeenCalledWith("sess-1", true)
    expect(mockCopilotRuntime.send).toHaveBeenCalledWith("sess-1", {
      prompt: "continue",
      agentMode: "interactive",
    })
  })

  it("routes a newly created live session before its transcript exists", async () => {
    mockCopilotRuntime.isSessionActive.mockReturnValue(true)
    mockFindJsonlPath.mockResolvedValue(null)
      const handler = getHandler("/api/send-message")
    const { req, res, next, sendBody } = createMockReqRes("POST", JSON.stringify({
      sessionId: "fresh-session",
      message: "follow up quickly",
      permissions: { mode: "default" },
    }))
    handler(req as never, res as never, next)
    sendBody()

    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(mockFindJsonlPath).not.toHaveBeenCalled()
    expect(mockResumeSDKSession).not.toHaveBeenCalled()
    expect(mockCopilotRuntime.send).toHaveBeenCalledWith("fresh-session", {
      prompt: "follow up quickly",
      agentMode: "interactive",
    })
    expect(res._getData()).toEqual({ success: true })
  })

  it("steers an active Copilot turn instead of queueing the follow-up", async () => {
    mockCopilotRuntime.isSessionActive.mockReturnValue(true)
    mockCopilotRuntime.isTurnActive.mockReturnValue(true)
    const handler = getHandler("/api/send-message")
    const { req, res, next, sendBody } = createMockReqRes("POST", JSON.stringify({
      sessionId: "sess-1",
      message: "focus on the parser first",
      permissions: { mode: "default" },
    }))
    handler(req as never, res as never, next)
    sendBody()

    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(mockCopilotRuntime.send).toHaveBeenCalledWith("sess-1", {
      prompt: "focus on the parser first",
      agentMode: "interactive",
      mode: "immediate",
    })
  })

  it("switches a loaded session from Plan back to Ask", async () => {
    mockCopilotRuntime.isSessionActive.mockReturnValue(true)
    const handler = getHandler("/api/send-message")

    for (const body of [
      { sessionId: "sess-1", message: "make a plan", permissions: { mode: "plan" } },
      { sessionId: "sess-1", message: "answer normally", permissions: { mode: "default" } },
    ]) {
      const { req, res, next, sendBody } = createMockReqRes("POST", JSON.stringify(body))
      handler(req as never, res as never, next)
      sendBody()
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    }

    expect(mockCopilotRuntime.send.mock.calls).toEqual([
      ["sess-1", { prompt: "make a plan", agentMode: "plan" }],
      ["sess-1", { prompt: "answer normally", agentMode: "interactive" }],
    ])
  })
})

describe("/api/send-message SDK resume cwd", () => {
  it("resumes instead of enqueueing into an aborted query", async () => {
    // Regression: an aborted query keeps activeQuery/messageStream set until
    // runQuery's finally runs. The route treated that as live, enqueued into a
    // stream nobody reads, and answered 200 — the message was silently lost and
    // the session appeared to stop responding.
    const abortedState = {
      sessionId: "sess-aborted",
      running: true,
      activeQuery: {},
      messageStream: {},
      abort: { signal: { aborted: true } },
    }
    mockSdkSessions.set("sess-aborted", abortedState)

    const handler = getHandler("/api/send-message")
    const { req, res, next, sendBody } = createMockReqRes(
      "POST",
      JSON.stringify({ sessionId: "sess-aborted", message: "still there?" }),
    )
    handler(req as never, res as never, next)
    sendBody()

    await vi.waitFor(() => expect(mockResumeSDKSession).toHaveBeenCalled())
    expect(mockSendSDKMessage).not.toHaveBeenCalled()
  })

  it("reuses an active SDK query after a turn result while workflows continue", async () => {
    const liveState = {
      sessionId: "sess-1",
      running: false,
      activeQuery: {},
      messageStream: {},
    }
    mockSdkSessions.set("sess-1", liveState)
    mockSendSDKMessage.mockReturnValue(liveState)

    const handler = getHandler("/api/send-message")
    const { req, res, next, sendBody } = createMockReqRes(
      "POST",
      JSON.stringify({ sessionId: "sess-1", message: "new direction", ultracode: true }),
    )
    handler(req as never, res as never, next)
    sendBody()

    await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
    expect(mockSendSDKMessage).toHaveBeenCalledWith(
      "sess-1",
      "new direction",
      undefined,
      expect.objectContaining({ ultracode: true }),
    )
    expect(mockResumeSDKSession).not.toHaveBeenCalled()
    expect(res._getData()).toEqual({ success: true })
  })

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
        cwd: "/Users/me/proj",
        model: "gpt-5.6-terra",
        serviceTier: "priority",
      }),
    )
    expect(mockCodexAppServer.resumeThread.mock.calls[0]?.[1]).not.toHaveProperty("path")
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
