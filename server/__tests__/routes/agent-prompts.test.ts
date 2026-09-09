// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockSdkSessions = new Map<string, unknown>()
const mockResolveElicitation = vi.fn()
const mockResolveUserDialog = vi.fn()
const mockGetSDKElicitations = vi.fn((..._args: unknown[]): unknown[] => [])
const mockGetSDKUserDialogs = vi.fn((..._args: unknown[]): unknown[] => [])
const mockListAgentPromptSessionIds = vi.fn((): string[] => [])

vi.mock("../../sdk-session", async (importOriginal) => ({
  // The route's content validator is the real one; everything the route reaches
  // into the live session for is stubbed.
  ...await importOriginal<typeof import("../../sdk-session")>(),
  get sdkSessions() { return mockSdkSessions },
  resolveElicitation: (...args: unknown[]) => mockResolveElicitation(...args),
  resolveUserDialog: (...args: unknown[]) => mockResolveUserDialog(...args),
  getSDKElicitations: (...args: unknown[]) => mockGetSDKElicitations(...args),
  getSDKUserDialogs: (...args: unknown[]) => mockGetSDKUserDialogs(...args),
  listAgentPromptSessionIds: () => mockListAgentPromptSessionIds(),
}))

import { registerAgentPromptRoutes } from "../../routes/agent-prompts"
import type { UseFn, Middleware } from "../../helpers"

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildHandler(path: string): Middleware {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (mounted, h) => { handlers.set(mounted, h) }
  registerAgentPromptRoutes(use)
  const captured = handlers.get(path)
  if (!captured) throw new Error(`registerAgentPromptRoutes did not mount ${path}`)
  return captured
}

/** Drain the microtask queue withJsonBody parses on. */
async function drainBodyParse() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

function makeReqRes(path: string, body: string) {
  const listeners: Record<string, ((chunk: string) => void)[]> = {}

  const req = {
    method: "POST",
    url: path,
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

  const simulate = async () => {
    req.emit("data", body)
    req.emit("end")
    await drainBodyParse()
  }

  return { req, res, next, simulate }
}

async function post(path: string, body: unknown) {
  const handler = buildHandler(path)
  const { req, res, next, simulate } = makeReqRes(
    path,
    typeof body === "string" ? body : JSON.stringify(body),
  )
  handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
  await simulate()
  return { status: res._getStatus(), body: res._getData() as Record<string, string>, next }
}

// ── GET /api/agent-prompts ────────────────────────────────────────────────────

describe("GET /api/agent-prompts", () => {
  beforeEach(() => {
    mockGetSDKElicitations.mockReset().mockReturnValue([])
    mockGetSDKUserDialogs.mockReset().mockReturnValue([])
    mockListAgentPromptSessionIds.mockReset().mockReturnValue([])
  })

  function invokeGet(): { status: number; body: unknown } {
    const handler = buildHandler("/api/agent-prompts")
    let status = 0
    let payload = ""
    const res = {
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

  it("groups parked elicitations and dialogs by session", () => {
    mockListAgentPromptSessionIds.mockReturnValue(["s1", "s2"])
    mockGetSDKElicitations.mockImplementation((sessionId: unknown) =>
      sessionId === "s1"
        ? [{ sessionId: "s1", requestId: "req-1", serverName: "github", message: "Token?", mode: "form", askedAt: 1, fields: [] }]
        : [],
    )
    mockGetSDKUserDialogs.mockImplementation((sessionId: unknown) =>
      sessionId === "s2"
        ? [{ sessionId: "s2", requestId: "dlg-1", dialogKind: "refusal_fallback_prompt", askedAt: 2, originalModel: "a", fallbackModel: "b" }]
        : [],
    )

    const { status, body } = invokeGet()

    expect(status).toBe(200)
    expect(body).toEqual({
      elicitationsBySession: {
        s1: [{ sessionId: "s1", requestId: "req-1", serverName: "github", message: "Token?", mode: "form", askedAt: 1, fields: [] }],
      },
      dialogsBySession: {
        s2: [{ sessionId: "s2", requestId: "dlg-1", dialogKind: "refusal_fallback_prompt", askedAt: 2, originalModel: "a", fallbackModel: "b" }],
      },
    })
  })

  it("returns empty maps when nothing is parked", () => {
    expect(invokeGet().body).toEqual({ elicitationsBySession: {}, dialogsBySession: {} })
  })
})

// ── POST /api/elicitation-answer ──────────────────────────────────────────────

describe("POST /api/elicitation-answer", () => {
  beforeEach(() => {
    mockSdkSessions.clear()
    mockResolveElicitation.mockReset()
  })

  it("resolves an accepted form answer", async () => {
    mockSdkSessions.set("s1", {})
    mockResolveElicitation.mockReturnValue({ found: true })

    const { status, body } = await post("/api/elicitation-answer", {
      sessionId: "s1",
      requestId: "req-1",
      action: "accept",
      content: { token: "abc", remember: true },
    })

    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(mockResolveElicitation).toHaveBeenCalledWith("s1", "req-1", {
      action: "accept",
      content: { token: "abc", remember: true },
    })
  })

  it("resolves a decline with no content", async () => {
    mockSdkSessions.set("s1", {})
    mockResolveElicitation.mockReturnValue({ found: true })

    const { status } = await post("/api/elicitation-answer", {
      sessionId: "s1",
      requestId: "req-1",
      action: "decline",
    })

    expect(status).toBe(200)
    expect(mockResolveElicitation).toHaveBeenCalledWith("s1", "req-1", { action: "decline" })
  })

  it("rejects an action the MCP result schema does not define", async () => {
    mockSdkSessions.set("s1", {})

    const { status, body } = await post("/api/elicitation-answer", {
      sessionId: "s1",
      requestId: "req-1",
      action: "maybe",
    })

    expect(status).toBe(400)
    expect(body.error).toContain("action")
    expect(mockResolveElicitation).not.toHaveBeenCalled()
  })

  it("rejects content that is not an object", async () => {
    mockSdkSessions.set("s1", {})

    const { status, body } = await post("/api/elicitation-answer", {
      sessionId: "s1",
      requestId: "req-1",
      action: "accept",
      content: ["nope"],
    })

    expect(status).toBe(400)
    expect(body.error).toContain("content")
  })

  it("returns 404 for a session that is not live", async () => {
    const { status } = await post("/api/elicitation-answer", {
      sessionId: "gone",
      requestId: "req-1",
      action: "decline",
    })
    expect(status).toBe(404)
  })

  it("returns 404 when the elicitation is already answered", async () => {
    mockSdkSessions.set("s1", {})
    mockResolveElicitation.mockReturnValue({ found: false })

    const { status, body } = await post("/api/elicitation-answer", {
      sessionId: "s1",
      requestId: "req-1",
      action: "decline",
    })

    expect(status).toBe(404)
    expect(body.error).toMatch(/not found|already/i)
  })

  it("returns 400 when requestId is missing", async () => {
    const { status, body } = await post("/api/elicitation-answer", {
      sessionId: "s1",
      action: "decline",
    })
    expect(status).toBe(400)
    expect(body.error).toContain("requestId")
  })

  it("returns 400 for a malformed body", async () => {
    const { status, body } = await post("/api/elicitation-answer", "{nope")
    expect(status).toBe(400)
    expect(body.error).toMatch(/invalid json/i)
  })

  it("calls next() for non-POST methods", () => {
    const handler = buildHandler("/api/elicitation-answer")
    const { req, res, next } = makeReqRes("/api/elicitation-answer", "")
    ;(req as { method: string }).method = "GET"
    handler(req as Parameters<Middleware>[0], res as unknown as Parameters<Middleware>[1], next)
    expect(next).toHaveBeenCalled()
  })
})

// ── POST /api/user-dialog-answer ──────────────────────────────────────────────

describe("POST /api/user-dialog-answer", () => {
  beforeEach(() => {
    mockSdkSessions.clear()
    mockResolveUserDialog.mockReset()
  })

  it("resolves a dialog choice", async () => {
    mockSdkSessions.set("s1", {})
    mockResolveUserDialog.mockReturnValue({ found: true })

    const { status, body } = await post("/api/user-dialog-answer", {
      sessionId: "s1",
      requestId: "dlg-1",
      choice: "retry_fallback",
    })

    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(mockResolveUserDialog).toHaveBeenCalledWith("s1", "dlg-1", "retry_fallback")
  })

  it("passes cancelled through so the CLI applies the dialog default", async () => {
    mockSdkSessions.set("s1", {})
    mockResolveUserDialog.mockReturnValue({ found: true })

    const { status } = await post("/api/user-dialog-answer", {
      sessionId: "s1",
      requestId: "dlg-1",
      choice: "cancelled",
    })

    expect(status).toBe(200)
    expect(mockResolveUserDialog).toHaveBeenCalledWith("s1", "dlg-1", "cancelled")
  })

  it("returns 400 when choice is missing", async () => {
    const { status, body } = await post("/api/user-dialog-answer", {
      sessionId: "s1",
      requestId: "dlg-1",
    })
    expect(status).toBe(400)
    expect(body.error).toContain("choice")
  })

  it("returns 404 when the dialog is no longer parked", async () => {
    mockSdkSessions.set("s1", {})
    mockResolveUserDialog.mockReturnValue({ found: false })

    const { status } = await post("/api/user-dialog-answer", {
      sessionId: "s1",
      requestId: "dlg-1",
      choice: "edit_prompt",
    })

    expect(status).toBe(404)
  })
})
