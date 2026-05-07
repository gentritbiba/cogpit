// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock sendJson from helpers
vi.mock("../../helpers", () => ({
  sendJson: (res: Record<string, unknown>, status: number, data: unknown) => {
    res.statusCode = status
    res.end(JSON.stringify(data))
  },
}))

// Mock sdk-session
const mockSendSDKMessage = vi.fn()
const mockSdkSessions = new Map<string, unknown>()

vi.mock("../../sdk-session", () => ({
  get sdkSessions() { return mockSdkSessions },
  sendSDKMessage: (...args: unknown[]) => mockSendSDKMessage(...args),
}))

import { registerAskUserRoutes } from "../../routes/ask-user"
import type { UseFn, Middleware } from "../../helpers"

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildHandler(): Middleware {
  let captured: Middleware | undefined
  const use: UseFn = (_path, h) => { captured = h }
  registerAskUserRoutes(use)
  if (!captured) throw new Error("registerAskUserRoutes did not call use()")
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
    end: vi.fn((data?: string) => { responseBody = data || "" }),
    _getStatus: () => statusCode,
    _getData: () => JSON.parse(responseBody) as unknown,
  }

  const next = vi.fn()

  // Simulate streaming the request body
  const simulate = () => {
    req.emit("data", body)
    req.emit("end")
  }

  return { req, res, next, simulate }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/ask-user-answer", () => {
  beforeEach(() => {
    mockSdkSessions.clear()
    mockSendSDKMessage.mockReset()
  })

  it("returns 200 and calls sendSDKMessage for a valid string[] payload", () => {
    const handler = buildHandler()

    mockSdkSessions.set("session-abc", {})
    mockSendSDKMessage.mockReturnValue({})

    const body = JSON.stringify({ sessionId: "session-abc", toolUseId: "tu-1", answers: ["Yes", "No"] })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    simulate()

    expect(res._getStatus()).toBe(200)
    expect(res._getData()).toEqual({ ok: true })
    expect(mockSendSDKMessage).toHaveBeenCalledWith("session-abc", "Yes\nNo")
  })

  it("returns 200 and calls sendSDKMessage for a Record<string, string> payload", () => {
    const handler = buildHandler()

    mockSdkSessions.set("session-abc", {})
    mockSendSDKMessage.mockReturnValue({})

    const body = JSON.stringify({ sessionId: "session-abc", toolUseId: "tu-2", answers: { q1: "blue", q2: "fast" } })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    simulate()

    expect(res._getStatus()).toBe(200)
    expect(res._getData()).toEqual({ ok: true })
    expect(mockSendSDKMessage).toHaveBeenCalledWith("session-abc", "blue\nfast")
  })

  it("returns 404 when sessionId is not a live SDK session", () => {
    const handler = buildHandler()

    // Do NOT add session to mockSdkSessions
    const body = JSON.stringify({ sessionId: "missing-session", toolUseId: "tu-1", answers: ["Yes"] })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    simulate()

    expect(res._getStatus()).toBe(404)
    expect((res._getData() as { error: string }).error).toMatch(/not found/i)
  })

  it("returns 400 when sessionId is missing", () => {
    const handler = buildHandler()

    const body = JSON.stringify({ toolUseId: "tu-1", answers: ["Yes"] })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    simulate()

    expect(res._getStatus()).toBe(400)
    expect((res._getData() as { error: string }).error).toContain("sessionId")
  })

  it("returns 400 when toolUseId is missing", () => {
    const handler = buildHandler()

    const body = JSON.stringify({ sessionId: "s1", answers: ["Yes"] })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    simulate()

    expect(res._getStatus()).toBe(400)
    expect((res._getData() as { error: string }).error).toContain("toolUseId")
  })

  it("returns 400 when answers is missing", () => {
    const handler = buildHandler()

    const body = JSON.stringify({ sessionId: "s1", toolUseId: "tu-1" })
    const { req, res, next, simulate } = makeReqRes(body)

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    simulate()

    expect(res._getStatus()).toBe(400)
    expect((res._getData() as { error: string }).error).toContain("answers")
  })

  it("returns 400 for malformed JSON body", () => {
    const handler = buildHandler()

    const { req, res, next, simulate } = makeReqRes("{invalid json")

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    simulate()

    expect(res._getStatus()).toBe(400)
    expect((res._getData() as { error: string }).error).toMatch(/invalid json/i)
  })

  it("calls next() for non-POST methods", () => {
    const handler = buildHandler()

    const { req, res, next } = makeReqRes("")
    ;(req as { method: string }).method = "GET"

    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)

    expect(next).toHaveBeenCalled()
    expect(mockSendSDKMessage).not.toHaveBeenCalled()
  })
})
