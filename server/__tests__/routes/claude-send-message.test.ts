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

import { describe, it, expect, vi, beforeEach } from "vitest"

const {
  mockActiveProcesses,
  mockPersistentSessions,
  mockSdkSessions,
  mockFindJsonlPath,
  mockGetSessionMeta,
  mockResumeSDKSession,
} = vi.hoisted(() => ({
  mockActiveProcesses: new Map<string, unknown>(),
  mockPersistentSessions: new Map<string, unknown>(),
  mockSdkSessions: new Map<string, unknown>(),
  mockFindJsonlPath: vi.fn(),
  mockGetSessionMeta: vi.fn(),
  mockResumeSDKSession: vi.fn(),
}))

vi.mock("../../helpers", () => ({
  activeProcesses: mockActiveProcesses,
  persistentSessions: mockPersistentSessions,
  findJsonlPath: mockFindJsonlPath,
  spawn: vi.fn(),
  homedir: () => "/Users/me",
  buildCodexPermArgs: vi.fn(() => []),
  buildCodexModelArgs: vi.fn(() => []),
  buildCodexEffortArgs: vi.fn(() => []),
  writeTempImageFiles: vi.fn().mockResolvedValue([]),
  cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
  getAgentKindFromSessionPath: vi.fn(() => "claude"),
  getSessionMeta: mockGetSessionMeta,
  friendlySpawnError: vi.fn((err: Error) => err.message),
}))

vi.mock("../../sdk-session", () => ({
  sdkSessions: mockSdkSessions,
  sendSDKMessage: vi.fn(),
  resumeSDKSession: mockResumeSDKSession,
  attachSubagentWatcher: vi.fn(),
}))

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

beforeEach(() => {
  vi.clearAllMocks()
  mockActiveProcesses.clear()
  mockPersistentSessions.clear()
  mockSdkSessions.clear()
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
