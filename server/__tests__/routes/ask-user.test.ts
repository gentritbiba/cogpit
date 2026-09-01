// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock sdk-session
const mockResolveUserQuestion = vi.fn()
const mockSdkSessions = new Map<string, unknown>()
const mockGetSDKUserQuestions = vi.fn((..._args: unknown[]): unknown[] => [])
const mockListUserQuestionSessionIds = vi.fn((): string[] => [])

vi.mock("../../sdk-session", () => ({
  get sdkSessions() { return mockSdkSessions },
  resolveUserQuestion: (...args: unknown[]) => mockResolveUserQuestion(...args),
  getSDKUserQuestions: (...args: unknown[]) => mockGetSDKUserQuestions(...args),
  listUserQuestionSessionIds: () => mockListUserQuestionSessionIds(),
}))

import {
  normalizeCopilotQuestion,
  registerAskUserRoutes,
  type CopilotQuestionClient,
} from "../../routes/ask-user"
import type { CopilotPendingUserInput } from "../../copilot-runtime"
import type { UseFn, Middleware } from "../../helpers"

// ── Helpers ───────────────────────────────────────────────────────────────────

function copilotQuestion(
  overrides: Partial<CopilotPendingUserInput> = {},
): CopilotPendingUserInput {
  return {
    sessionId: "copilot-1",
    requestId: "input-1",
    question: "Which environment?",
    choices: ["staging", "production"],
    allowFreeform: true,
    askedAt: 123,
    ...overrides,
  }
}

function makeCopilot(
  pending: CopilotPendingUserInput[] = [],
): CopilotQuestionClient {
  const active = new Set(pending.map(({ sessionId }) => sessionId))
  return {
    getPendingUserInputs: vi.fn((sessionId?: string) =>
      sessionId === undefined
        ? pending
        : pending.filter((item) => item.sessionId === sessionId),
    ),
    isSessionActive: vi.fn((sessionId: string) => active.has(sessionId)),
    answerUserInput: vi.fn(),
  }
}

function buildHandler(
  path = "/api/ask-user-answer",
  copilot: CopilotQuestionClient = makeCopilot(),
): Middleware {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (mounted, h) => { handlers.set(mounted, h) }
  registerAskUserRoutes(use, copilot)
  const captured = handlers.get(path)
  if (!captured) throw new Error(`registerAskUserRoutes did not mount ${path}`)
  return captured
}

function makeReqRes(body: string) {
  const listeners: Record<string, ((chunk: string) => void)[]> = {}

  const req = {
    method: "POST",
    url: "/api/ask-user-answer",
    on: (event: string, cb: (chunk: string) => void) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    emit: (event: string, data?: string) => {
      for (const cb of listeners[event] ?? []) cb(data ?? "")
    },
  }

  let statusCode = 200
  let responseBody = ""
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn(),
    end: vi.fn((data?: string) => { responseBody = data || "" }),
    _getStatus: () => statusCode,
    _getData: () => JSON.parse(responseBody) as unknown,
  }

  const next = vi.fn()

  // Simulate streaming the request body. The route parses through
  // withJsonBody, so the handler runs on the microtask queue rather than
  // inside the "end" emit; drain it before asserting.
  const simulate = async () => {
    req.emit("data", body)
    req.emit("end")
    await drainBodyParse()
  }

  return { req, res, next, simulate }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/**
 * Drain the microtask queue that withJsonBody parses on. Deliberately not
 * setImmediate: several tests here run with fake timers, which never fire it.
 * readJsonBody settles through promises only, so yielding is enough.
 */
async function drainBodyParse() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe("POST /api/ask-user-answer", () => {
  beforeEach(() => {
    mockSdkSessions.clear()
    mockResolveUserQuestion.mockReset()
  })

  it("returns 200 and resolves a valid string[] payload", async () => {
    const handler = buildHandler()

    mockSdkSessions.set("session-abc", {})
    mockResolveUserQuestion.mockReturnValue({ found: true })

    const body = JSON.stringify({ sessionId: "session-abc", toolUseId: "tu-1", answers: ["Yes", "No"] })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    await simulate()

    expect(res._getStatus()).toBe(200)
    expect(res._getData()).toEqual({ ok: true })
    expect(mockResolveUserQuestion).toHaveBeenCalledWith("session-abc", "tu-1", ["Yes", "No"])
  })

  it("returns 200 and resolves a Record<string, string> payload", async () => {
    const handler = buildHandler()

    mockSdkSessions.set("session-abc", {})
    mockResolveUserQuestion.mockReturnValue({ found: true })

    const body = JSON.stringify({ sessionId: "session-abc", toolUseId: "tu-2", answers: { q1: "blue", q2: "fast" } })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    await simulate()

    expect(res._getStatus()).toBe(200)
    expect(res._getData()).toEqual({ ok: true })
    expect(mockResolveUserQuestion).toHaveBeenCalledWith("session-abc", "tu-2", { q1: "blue", q2: "fast" })
  })

  it("answers a Copilot choice through the pending JSON-RPC request", async () => {
    const pending = copilotQuestion()
    const copilot = makeCopilot([pending])
    const handler = buildHandler("/api/ask-user-answer", copilot)
    const body = JSON.stringify({
      sessionId: "copilot-1",
      toolUseId: "input-1",
      answers: { "Which environment?": "staging" },
    })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    await simulate()

    expect(res._getStatus()).toBe(200)
    expect(res._getData()).toEqual({ ok: true })
    expect(copilot.answerUserInput).toHaveBeenCalledWith(
      "copilot-1",
      "input-1",
      { answer: "staging", wasFreeform: false },
    )
    expect(mockResolveUserQuestion).not.toHaveBeenCalled()
  })

  it("matches a Copilot timeline tool call to its pending question", async () => {
    const pending = copilotQuestion({ requestId: "rpc-request-1" })
    const copilot = makeCopilot([pending])
    const handler = buildHandler("/api/ask-user-answer", copilot)
    const body = JSON.stringify({
      sessionId: "copilot-1",
      toolUseId: "toolu_ask_user_1",
      answers: { "Which environment?": "production" },
    })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    await simulate()

    expect(res._getStatus()).toBe(200)
    expect(copilot.answerUserInput).toHaveBeenCalledWith(
      "copilot-1",
      "rpc-request-1",
      { answer: "production", wasFreeform: false },
    )
  })

  it("marks a Copilot typed answer as freeform", async () => {
    const copilot = makeCopilot([copilotQuestion()])
    const handler = buildHandler("/api/ask-user-answer", copilot)
    const { req, res, next, simulate } = makeReqRes(JSON.stringify({
      sessionId: "copilot-1",
      toolUseId: "input-1",
      answers: { "Which environment?": "preview" },
    }))

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    await simulate()

    expect(copilot.answerUserInput).toHaveBeenCalledWith(
      "copilot-1",
      "input-1",
      { answer: "preview", wasFreeform: true },
    )
  })

  it("returns 404 when sessionId is not a live SDK session", async () => {
    const handler = buildHandler()

    // Do NOT add session to mockSdkSessions
    const body = JSON.stringify({ sessionId: "missing-session", toolUseId: "tu-1", answers: ["Yes"] })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    await simulate()

    expect(res._getStatus()).toBe(404)
    expect((res._getData() as { error: string }).error).toMatch(/not found/i)
  })

  it("returns 400 when sessionId is missing", async () => {
    const handler = buildHandler()

    const body = JSON.stringify({ toolUseId: "tu-1", answers: ["Yes"] })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    await simulate()

    expect(res._getStatus()).toBe(400)
    expect((res._getData() as { error: string }).error).toContain("sessionId")
  })

  it("returns 400 when toolUseId is missing", async () => {
    const handler = buildHandler()

    const body = JSON.stringify({ sessionId: "s1", answers: ["Yes"] })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    await simulate()

    expect(res._getStatus()).toBe(400)
    expect((res._getData() as { error: string }).error).toContain("toolUseId")
  })

  it("returns 400 when answers is missing", async () => {
    const handler = buildHandler()

    const body = JSON.stringify({ sessionId: "s1", toolUseId: "tu-1" })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    await simulate()

    expect(res._getStatus()).toBe(400)
    expect((res._getData() as { error: string }).error).toContain("answers")
  })

  it("returns 400 for malformed JSON body", async () => {
    const handler = buildHandler()

    const { req, res, next, simulate } = makeReqRes("{invalid json")

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    await simulate()

    expect(res._getStatus()).toBe(400)
    expect((res._getData() as { error: string }).error).toMatch(/invalid json/i)
  })

  it("calls next() for non-POST methods", async () => {
    const handler = buildHandler()

    const { req, res, next } = makeReqRes("")
    ;(req as { method: string }).method = "GET"

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)

    expect(next).toHaveBeenCalled()
    expect(mockResolveUserQuestion).not.toHaveBeenCalled()
  })
})

describe("GET /api/user-questions", () => {
  beforeEach(() => {
    mockGetSDKUserQuestions.mockReset().mockReturnValue([])
    mockListUserQuestionSessionIds.mockReset().mockReturnValue([])
  })

  function invokeGet(copilot: CopilotQuestionClient = makeCopilot()): { status: number; body: unknown } {
    const handler = buildHandler("/api/user-questions", copilot)
    let status = 0
    let payload = ""
    const res = {
      statusCode: 200,
      setHeader: vi.fn(),
      end: vi.fn((value?: string) => { payload = value ?? "" }),
    }
    Object.defineProperty(res, "statusCode", {
      get: () => status,
      set: (v: number) => { status = v },
    })
    const next = vi.fn()
    handler(
      { method: "GET", url: "" } as unknown as Parameters<Middleware>[0],
      res as unknown as Parameters<Middleware>[1],
      next,
    )
    return { status, body: payload ? JSON.parse(payload) : null }
  }

  it("groups blocked questions by session", async () => {
    // Mission Control renders cards for sessions that are not open, so it needs
    // one call covering all of them.
    mockListUserQuestionSessionIds.mockReturnValue(["s1"])
    mockGetSDKUserQuestions.mockImplementation((sessionId: unknown) =>
      sessionId === "s1"
        ? [{ sessionId: "s1", toolUseId: "toolu_1", askedAt: 1, questions: [] }]
        : [],
    )

    const { status, body } = invokeGet()

    expect(status).toBe(200)
    expect(body).toEqual({
      bySession: { s1: [{ sessionId: "s1", toolUseId: "toolu_1", askedAt: 1, questions: [] }] },
    })
  })

  it("normalizes and groups Copilot input requests", () => {
    const pending = copilotQuestion()
    expect(normalizeCopilotQuestion(pending)).toEqual({
      sessionId: "copilot-1",
      toolUseId: "input-1",
      askedAt: 123,
      questions: [{
        question: "Which environment?",
        multiSelect: false,
        options: [
          { label: "staging", hasPreview: false },
          { label: "production", hasPreview: false },
        ],
      }],
    })
    expect(invokeGet(makeCopilot([pending])).body).toEqual({
      bySession: {
        "copilot-1": [normalizeCopilotQuestion(pending)],
      },
    })
  })

  it("omits sessions with nothing pending", async () => {
    mockListUserQuestionSessionIds.mockReturnValue(["quiet"])
    mockGetSDKUserQuestions.mockReturnValue([])

    expect(invokeGet().body).toEqual({ bySession: {} })
  })

  it("returns an empty map when no session is blocked", async () => {
    expect(invokeGet().body).toEqual({ bySession: {} })
  })
})
