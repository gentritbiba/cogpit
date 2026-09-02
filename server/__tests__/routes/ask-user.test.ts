// @vitest-environment node
import { describe, it, expect, vi } from "vitest"
import { registerAskUserRoutes, type QuestionRuntimes } from "../../routes/ask-user"
import { normalizeCopilotQuestion } from "../../agents/copilotRuntime"
import { AgentRuntimeError, type AgentRuntime } from "../../agents/runtimeTypes"
import type { CopilotPendingUserInput } from "../../agents/copilotTransport"
import type { AgentKind } from "../../../shared/session/agent-descriptors"
import type { UseFn, Middleware } from "../../helpers"

/**
 * `/api/user-questions` and `/api/ask-user-answer` over the runtime registry.
 *
 * The route used to decide "is this Copilot?" by asking whether the id was
 * absent from the Claude session map, so a Codex session took the Copilot path
 * and collected an error about a session Copilot had never opened. It now
 * resolves the session's agent first, which is what these cases pin.
 */

// ── Fakes ─────────────────────────────────────────────────────────────────────

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

type FakeRuntime = Pick<AgentRuntime, "kind" | "listPendingQuestions" | "answerQuestion">

function fakeRuntime(kind: AgentKind, overrides: Partial<FakeRuntime> = {}): FakeRuntime {
  return {
    kind,
    listPendingQuestions: vi.fn(() => []),
    answerQuestion: vi.fn(async () => false),
    ...overrides,
  }
}

function registryOf(
  runtimes: Partial<Record<AgentKind, FakeRuntime>>,
  owner: AgentKind = "claude",
): QuestionRuntimes {
  const table: Record<AgentKind, FakeRuntime> = {
    claude: runtimes.claude ?? fakeRuntime("claude"),
    codex: runtimes.codex ?? fakeRuntime("codex"),
    copilot: runtimes.copilot ?? fakeRuntime("copilot"),
  }
  return {
    allRuntimes: () => Object.values(table) as unknown as AgentRuntime[],
    runtimeFor: (kind) => table[kind] as unknown as AgentRuntime,
    resolveSessionAgent: async () => ({ kind: owner, filePath: null }),
  }
}

function buildHandler(path: string, runtimes: QuestionRuntimes): Middleware {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (mounted, handler) => { handlers.set(mounted, handler) }
  registerAskUserRoutes(use, runtimes)
  const captured = handlers.get(path)
  if (!captured) throw new Error(`registerAskUserRoutes did not mount ${path}`)
  return captured
}

/**
 * Drain the microtask queue that withJsonBody parses on. Deliberately not
 * setImmediate: several tests here run with fake timers, which never fire it.
 * readJsonBody settles through promises only, so yielding is enough.
 */
async function drainBodyParse() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

function makeReqRes(body: string, method = "POST") {
  const listeners: Record<string, ((chunk: string) => void)[]> = {}
  const req = {
    method,
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
    _getData: () => JSON.parse(responseBody) as { error?: string; ok?: boolean; code?: string },
  }

  const next = vi.fn()
  const simulate = async () => {
    req.emit("data", body)
    req.emit("end")
    await drainBodyParse()
  }
  return { req, res, next, simulate }
}

async function post(runtimes: QuestionRuntimes, body: unknown) {
  const handler = buildHandler("/api/ask-user-answer", runtimes)
  const { req, res, next, simulate } = makeReqRes(
    typeof body === "string" ? body : JSON.stringify(body),
  )
  handler(
    req as Parameters<Middleware>[0],
    res as unknown as Parameters<Middleware>[1],
    next,
  )
  await simulate()
  return { res, next }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/ask-user-answer", () => {
  it.each<AgentKind>(["claude", "codex", "copilot"])(
    "answers through the %s runtime that owns the session",
    async (kind) => {
      const runtime = fakeRuntime(kind, { answerQuestion: vi.fn(async () => true) })
      const others = (["claude", "codex", "copilot"] as const)
        .filter((other) => other !== kind)
        .map((other) => fakeRuntime(other))

      const { res } = await post(
        registryOf(
          { [kind]: runtime, ...Object.fromEntries(others.map((r) => [r.kind, r])) },
          kind,
        ),
        { sessionId: "session-abc", toolUseId: "tu-1", answers: ["Yes", "No"] },
      )

      expect(res._getStatus()).toBe(200)
      expect(res._getData()).toEqual({ ok: true })
      expect(runtime.answerQuestion).toHaveBeenCalledWith("session-abc", "tu-1", ["Yes", "No"])
      for (const other of others) {
        expect(other.answerQuestion).not.toHaveBeenCalled()
      }
    },
  )

  it("forwards a Record<string, string> payload unchanged", async () => {
    const runtime = fakeRuntime("claude", { answerQuestion: vi.fn(async () => true) })
    const { res } = await post(registryOf({ claude: runtime }), {
      sessionId: "session-abc",
      toolUseId: "tu-2",
      answers: { q1: "blue", q2: "fast" },
    })

    expect(res._getStatus()).toBe(200)
    expect(runtime.answerQuestion).toHaveBeenCalledWith(
      "session-abc",
      "tu-2",
      { q1: "blue", q2: "fast" },
    )
  })

  it("returns 404 when the runtime has no such question", async () => {
    const { res } = await post(registryOf({}), {
      sessionId: "missing-session",
      toolUseId: "tu-1",
      answers: ["Yes"],
    })

    expect(res._getStatus()).toBe(404)
    expect(res._getData().error).toMatch(/not found/i)
  })

  it("surfaces the runtime's own status and code for a failed answer", async () => {
    const runtime = fakeRuntime("copilot", {
      answerQuestion: vi.fn(async () => {
        throw new AgentRuntimeError(502, "COPILOT_USER_INPUT_FAILED", "transport closed")
      }),
    })

    const { res } = await post(registryOf({ copilot: runtime }, "copilot"), {
      sessionId: "copilot-1",
      toolUseId: "input-1",
      answers: "staging",
    })

    expect(res._getStatus()).toBe(502)
    expect(res._getData()).toEqual({
      error: "transport closed",
      code: "COPILOT_USER_INPUT_FAILED",
    })
  })

  it.each([
    ["sessionId", { toolUseId: "tu-1", answers: ["Yes"] }],
    ["toolUseId", { sessionId: "s1", answers: ["Yes"] }],
    ["answers", { sessionId: "s1", toolUseId: "tu-1" }],
  ])("returns 400 when %s is missing", async (field, body) => {
    const { res } = await post(registryOf({}), body)
    expect(res._getStatus()).toBe(400)
    expect(res._getData().error).toContain(field)
  })

  it("returns 400 for malformed JSON body", async () => {
    const { res } = await post(registryOf({}), "{invalid json")
    expect(res._getStatus()).toBe(400)
    expect(res._getData().error).toMatch(/invalid json/i)
  })

  it("calls next() for non-POST methods", async () => {
    const runtime = fakeRuntime("claude")
    const handler = buildHandler("/api/ask-user-answer", registryOf({ claude: runtime }))
    const { req, res, next } = makeReqRes("", "GET")

    handler(
      req as Parameters<Middleware>[0],
      res as unknown as Parameters<Middleware>[1],
      next,
    )

    expect(next).toHaveBeenCalled()
    expect(runtime.answerQuestion).not.toHaveBeenCalled()
  })
})

describe("GET /api/user-questions", () => {
  function invokeGet(runtimes: QuestionRuntimes): { status: number; body: unknown } {
    const handler = buildHandler("/api/user-questions", runtimes)
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

  it("groups every runtime's blocked questions by session", () => {
    // Mission Control renders cards for sessions that are not open, so it needs
    // one call covering all of them.
    const claudeQuestion = { sessionId: "s1", toolUseId: "toolu_1", askedAt: 1, questions: [] }
    const copilotPending = normalizeCopilotQuestion(copilotQuestion())

    const { status, body } = invokeGet(registryOf({
      claude: fakeRuntime("claude", { listPendingQuestions: vi.fn(() => [claudeQuestion]) }),
      copilot: fakeRuntime("copilot", { listPendingQuestions: vi.fn(() => [copilotPending]) }),
    }))

    expect(status).toBe(200)
    expect(body).toEqual({
      bySession: { s1: [claudeQuestion], "copilot-1": [copilotPending] },
    })
  })

  it("normalizes a Copilot input request into the shared question shape", () => {
    expect(normalizeCopilotQuestion(copilotQuestion())).toEqual({
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
  })

  it("returns an empty map when no session is blocked", () => {
    expect(invokeGet(registryOf({})).body).toEqual({ bySession: {} })
  })
})
