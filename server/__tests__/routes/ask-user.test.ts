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

import { registerAskUserRoutes } from "../../routes/ask-user"
import type { UseFn, Middleware } from "../../helpers"

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildHandler(path = "/api/ask-user-answer"): Middleware {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (mounted, h) => { handlers.set(mounted, h) }
  registerAskUserRoutes(use)
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

  function invokeGet(): { status: number; body: unknown } {
    const handler = buildHandler("/api/user-questions")
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

  it("omits sessions with nothing pending", async () => {
    mockListUserQuestionSessionIds.mockReturnValue(["quiet"])
    mockGetSDKUserQuestions.mockReturnValue([])

    expect(invokeGet().body).toEqual({ bySession: {} })
  })

  it("returns an empty map when no session is blocked", async () => {
    expect(invokeGet().body).toEqual({ bySession: {} })
  })
})
