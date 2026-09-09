// @vitest-environment node
import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import type { CopilotPendingExitPlan } from "../../agents/copilotTransport"
import type { AgentKind } from "../../../shared/session/agent-descriptors"
import {
  AgentRuntimeError,
  type AgentRuntime,
  type ApprovalDecision,
  type PendingApproval,
} from "../../agents/runtimeTypes"

/**
 * `/api/permissions` over the runtime registry.
 *
 * Requests come from the runtime that actually holds the session. The old code
 * walked a fixed agent precedence and took whichever answered first with a
 * non-empty list, so a live session with nothing pending handed its id to the
 * next agent in line — which is the collision these cases pin shut. The
 * normalisers and decision codecs are asserted in agents/approvals.test.ts.
 */

const { mockPersistentSessions } = vi.hoisted(() => ({
  mockPersistentSessions: new Map<string, unknown>(),
}))

vi.mock("../../processRegistry", () => ({
  persistentSessions: mockPersistentSessions,
  activeProcesses: new Map(),
}))

import {
  registerPermissionRoutes,
  type CopilotPlanClient,
  type PermissionRuntimes,
} from "../../routes/permissions"

interface FakeResponse {
  statusCode: number
  setHeader: Mock<(name: string, value: string) => void>
  end: Mock<(value?: string) => void>
  json: () => unknown
}

function pendingApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    sessionId: "session-1",
    requestId: "r1",
    toolName: "Bash",
    input: { command: "bun test" },
    toolUseId: "tool-1",
    title: "Run command",
    displayName: "Command execution",
    timestamp: 7,
    availableDecisions: ["allow", "allow_always", "deny"],
    ...overrides,
  }
}

type FakeRuntime = Pick<
  AgentRuntime,
  "kind" | "listPendingApprovals" | "respondToApproval" | "respondToAllApprovals"
>

function fakeRuntime(kind: AgentKind, pending: PendingApproval[] = []): FakeRuntime {
  return {
    kind,
    listPendingApprovals: vi.fn((sessionId?: string) =>
      sessionId === undefined
        ? pending
        : pending.filter((item) => item.sessionId === sessionId),
    ),
    respondToApproval: vi.fn(async () => true),
    respondToAllApprovals: vi.fn(async () => ({
      count: pending.length,
      toolNames: [...new Set(pending.map(({ toolName }) => toolName))],
    })),
  }
}

/** A registry whose owner lookup is the runtime that has the session listed. */
function registryOf(runtimes: FakeRuntime[]): PermissionRuntimes {
  return {
    allRuntimes: () => runtimes as unknown as AgentRuntime[],
    runtimeForSession: (sessionId) =>
      (runtimes.find((runtime) =>
        runtime.listPendingApprovals(sessionId).length > 0,
      ) ?? null) as AgentRuntime | null,
  }
}

function planClient(plans: CopilotPendingExitPlan[] = []): CopilotPlanClient {
  return {
    getPendingExitPlans: vi.fn((sessionId?: string) =>
      sessionId === undefined
        ? plans
        : plans.filter((item) => item.sessionId === sessionId),
    ),
    answerExitPlan: vi.fn(),
  }
}

function register(
  runtimes: PermissionRuntimes,
  copilot: CopilotPlanClient = planClient(),
): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (_path, registered) => { handler = registered }
  registerPermissionRoutes(use, runtimes, copilot)
  if (!handler) throw new Error("Permission route was not registered")
  return handler
}

async function invoke(
  handler: Middleware,
  options: { method: string; url: string; body?: unknown },
): Promise<{ response: FakeResponse; next: ReturnType<typeof vi.fn> }> {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string }
  req.method = options.method
  req.url = options.url
  let payload = ""
  const response: FakeResponse = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => { payload = value ?? "" }),
    json: () => JSON.parse(payload) as unknown,
  }
  const next = vi.fn()
  handler(
    req as unknown as Parameters<Middleware>[0],
    response as unknown as Parameters<Middleware>[1],
    next,
  )
  if (options.body !== undefined) req.emit("data", JSON.stringify(options.body))
  req.emit("end")
  await vi.waitFor(() => {
    expect(response.end.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0)
  })
  return { response, next }
}

beforeEach(() => {
  mockPersistentSessions.clear()
})

describe("GET /api/permissions/:sessionId", () => {
  it.each<AgentKind>(["claude", "codex", "copilot"])(
    "lists what the %s runtime holds for the session",
    async (kind) => {
      const owned = pendingApproval({ sessionId: "session-1", requestId: `${kind}-1` })
      const runtimes = [
        fakeRuntime("claude", kind === "claude" ? [owned] : []),
        fakeRuntime("codex", kind === "codex" ? [owned] : []),
        fakeRuntime("copilot", kind === "copilot" ? [owned] : []),
      ]

      const { response } = await invoke(register(registryOf(runtimes)), {
        method: "GET",
        url: "/session-1",
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ permissions: [owned], plan: null })
    },
  )

  it("does not hand a live session's id to the next agent in line", async () => {
    // The old precedence walk returned the first non-empty list, so a Claude
    // session with nothing pending was answered from Codex's registry.
    const claude = fakeRuntime("claude")
    const codex = fakeRuntime("codex", [pendingApproval({ sessionId: "session-1" })])
    const runtimes: PermissionRuntimes = {
      allRuntimes: () => [claude, codex] as unknown as AgentRuntime[],
      runtimeForSession: () => claude as unknown as AgentRuntime,
    }

    const { response } = await invoke(register(runtimes), {
      method: "GET",
      url: "/session-1",
    })

    expect(response.json()).toEqual({ permissions: [], plan: null })
    expect(codex.listPendingApprovals).not.toHaveBeenCalledWith("session-1")
  })

  it("returns the session's pending exit plan alongside its permissions", async () => {
    const plan: CopilotPendingExitPlan = {
      sessionId: "copilot-1",
      requestId: "plan-1",
      summary: "Implementation plan",
      planContent: "1. Update the route",
      actions: ["interactive", "autopilot"],
      recommendedAction: "interactive",
      askedAt: 123,
    }
    const { response } = await invoke(
      register(registryOf([fakeRuntime("copilot")]), planClient([plan])),
      { method: "GET", url: "/copilot-1" },
    )

    expect(response.json()).toEqual({ permissions: [], plan })
  })
})

describe("POST /api/permissions/:sessionId/respond", () => {
  it("answers through the runtime that owns the session", async () => {
    const codex = fakeRuntime("codex", [pendingApproval({ sessionId: "thread-1" })])
    const claude = fakeRuntime("claude")

    const { response } = await invoke(register(registryOf([claude, codex])), {
      method: "POST",
      url: "/thread-1/respond",
      body: { requestId: "r1", behavior: "allow_always" },
    })

    expect(codex.respondToApproval).toHaveBeenCalledWith("thread-1", "r1", "allow_always")
    expect(claude.respondToApproval).not.toHaveBeenCalled()
    expect(response.json()).toEqual({
      success: true,
      action: "allowed",
      toolName: "Bash",
      shouldRetry: false,
    })
  })

  it("omits the retry hint for the SDK path, which never needs one", async () => {
    const claude = fakeRuntime("claude", [pendingApproval({ sessionId: "sdk-1", toolName: "Read" })])

    const { response } = await invoke(register(registryOf([claude])), {
      method: "POST",
      url: "/sdk-1/respond",
      body: { requestId: "r1", behavior: "allow" },
    })

    expect(response.json()).toEqual({ success: true, action: "allowed", toolName: "Read" })
  })

  it("reports a request that resolved before the answer arrived", async () => {
    const runtime = fakeRuntime("codex", [pendingApproval({ sessionId: "thread-1" })])
    vi.mocked(runtime.respondToApproval).mockResolvedValue(false)

    const { response } = await invoke(register(registryOf([runtime])), {
      method: "POST",
      url: "/thread-1/respond",
      body: { requestId: "r1", behavior: "allow" },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: "Permission request not found or already resolved",
    })
  })

  it("passes the runtime's own status and code straight through", async () => {
    const runtime = fakeRuntime("codex", [pendingApproval({ sessionId: "thread-1" })])
    vi.mocked(runtime.respondToApproval).mockRejectedValue(
      new AgentRuntimeError(400, "CODEX_APPROVAL_DECISION_UNAVAILABLE", "not available", {
        requestId: "r1",
        availableDecisions: ["allow", "deny"],
      }),
    )

    const { response } = await invoke(register(registryOf([runtime])), {
      method: "POST",
      url: "/thread-1/respond",
      body: { requestId: "r1", behavior: "allow_always" },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: "not available",
      code: "CODEX_APPROVAL_DECISION_UNAVAILABLE",
      requestId: "r1",
      availableDecisions: ["allow", "deny"],
    })
  })

  it("returns 404 for a session no runtime holds", async () => {
    const { response } = await invoke(register(registryOf([fakeRuntime("claude")])), {
      method: "POST",
      url: "/ghost/respond",
      body: { requestId: "r1", behavior: "allow" },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: "Session not found" })
  })

  it.each<[string, unknown]>([
    ["requestId is missing", { behavior: "allow" }],
    ["behavior is not a decision", { requestId: "r1", behavior: "maybe" }],
  ])("returns 400 when %s", async (_label, body) => {
    const { response } = await invoke(register(registryOf([fakeRuntime("claude")])), {
      method: "POST",
      url: "/session-1/respond",
      body,
    })
    expect(response.statusCode).toBe(400)
  })
})

describe("POST /api/permissions/:sessionId/respond-all", () => {
  it("delegates the whole batch to the owning runtime", async () => {
    const runtime = fakeRuntime("codex", [
      pendingApproval({ sessionId: "thread-1" }),
      pendingApproval({ sessionId: "thread-1", requestId: "r2", toolName: "Write" }),
    ])

    const { response } = await invoke(register(registryOf([runtime])), {
      method: "POST",
      url: "/thread-1/respond-all",
      body: { behavior: "deny" },
    })

    expect(runtime.respondToAllApprovals).toHaveBeenCalledWith("thread-1", "deny")
    expect(response.json()).toEqual({
      success: true,
      action: "denied",
      count: 2,
      toolNames: ["Bash", "Write"],
      shouldRetry: false,
    })
  })

  it("surfaces a refused batch rather than answering part of it", async () => {
    const runtime = fakeRuntime("copilot", [pendingApproval({ sessionId: "copilot-1" })])
    vi.mocked(runtime.respondToAllApprovals).mockRejectedValue(
      new AgentRuntimeError(400, "COPILOT_PERMISSION_DECISION_UNAVAILABLE", "not available", {
        requestId: "r1",
        availableDecisions: ["allow", "deny"],
      }),
    )

    const { response } = await invoke(register(registryOf([runtime])), {
      method: "POST",
      url: "/copilot-1/respond-all",
      body: { behavior: "allow_always" },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      code: "COPILOT_PERMISSION_DECISION_UNAVAILABLE",
      requestId: "r1",
    })
  })

  it("returns 400 for an unknown behavior", async () => {
    const { response } = await invoke(register(registryOf([fakeRuntime("claude")])), {
      method: "POST",
      url: "/session-1/respond-all",
      body: { behavior: "sometimes" },
    })
    expect(response.statusCode).toBe(400)
  })
})

describe("GET /api/permissions — cross-session listing", () => {
  it("groups pending requests from every runtime by session", async () => {
    // Mission Control renders cards for sessions that are not open, so it needs
    // one call that covers all of them rather than a poll per session.
    const runtimes = [
      fakeRuntime("claude", [pendingApproval({ sessionId: "sdk-session" })]),
      fakeRuntime("codex", [pendingApproval({ sessionId: "codex-thread" })]),
      fakeRuntime("copilot", [pendingApproval({ sessionId: "copilot-1" })]),
    ]

    const { response } = await invoke(register(registryOf(runtimes)), {
      method: "GET",
      url: "",
    })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { bySession: Record<string, unknown[]> }
    expect(Object.keys(body.bySession).sort()).toEqual([
      "codex-thread",
      "copilot-1",
      "sdk-session",
    ])
  })

  it("omits sessions with nothing pending", async () => {
    const { response } = await invoke(register(registryOf([fakeRuntime("claude")])), {
      method: "GET",
      url: "",
    })
    expect(response.json()).toEqual({ bySession: {}, plansBySession: {} })
  })

  it("answers the bare path even with a query string", async () => {
    const { response } = await invoke(register(registryOf([fakeRuntime("claude")])), {
      method: "GET",
      url: "?x=1",
    })
    expect(response.statusCode).toBe(200)
  })

  it("summarises requests instead of shipping the raw tool input", async () => {
    // A pending Write carries the entire file being written, and this list is
    // polled app-wide — sending it would put that payload on the wire every few
    // seconds for every client, including remote and tunnel ones.
    const wholeFile = "x".repeat(5000)
    const runtime = fakeRuntime("claude", [pendingApproval({
      sessionId: "s1",
      toolName: "Write",
      input: { file_path: "/big.ts", content: wholeFile },
      title: undefined,
      displayName: undefined,
    })])

    const { response } = await invoke(register(registryOf([runtime])), {
      method: "GET",
      url: "",
    })
    const body = response.json() as { bySession: Record<string, Record<string, unknown>[]> }

    expect(body.bySession.s1[0]).toEqual({
      sessionId: "s1",
      requestId: "r1",
      toolName: "Write",
      summary: "/big.ts",
      availableDecisions: ["allow", "allow_always", "deny"],
      timestamp: 7,
    })
    expect(JSON.stringify(body)).not.toContain(wholeFile)
  })

  it("omits full plan content from the cross-session poll", async () => {
    const plan: CopilotPendingExitPlan = {
      sessionId: "copilot-1",
      requestId: "plan-1",
      summary: "Implementation plan",
      planContent: "A very large private implementation plan",
      actions: ["interactive", "autopilot"],
      recommendedAction: "interactive",
      askedAt: 123,
    }

    const { response } = await invoke(
      register(registryOf([fakeRuntime("claude")]), planClient([plan])),
      { method: "GET", url: "" },
    )

    expect(response.json()).toEqual({
      bySession: {},
      plansBySession: {
        "copilot-1": [{
          sessionId: "copilot-1",
          requestId: "plan-1",
          summary: "Implementation plan",
        }],
      },
    })
  })
})

describe("POST /api/permissions/:sessionId/plan", () => {
  const plan: CopilotPendingExitPlan = {
    sessionId: "copilot-1",
    requestId: "plan-1",
    summary: "Implementation plan",
    actions: ["interactive", "autopilot"],
    recommendedAction: "interactive",
    askedAt: 123,
  }

  it("answers a pending exit plan", async () => {
    const copilot = planClient([plan])
    const { response } = await invoke(register(registryOf([fakeRuntime("copilot")]), copilot), {
      method: "POST",
      url: "/copilot-1/plan",
      body: { requestId: "plan-1", approved: true, selectedAction: "autopilot" },
    })

    expect(response.statusCode).toBe(200)
    expect(copilot.answerExitPlan).toHaveBeenCalledWith(
      "copilot-1",
      "plan-1",
      { approved: true, selectedAction: "autopilot" },
    )
  })

  it("returns 404 for a plan that is no longer pending", async () => {
    const { response } = await invoke(register(registryOf([fakeRuntime("copilot")])), {
      method: "POST",
      url: "/copilot-1/plan",
      body: { requestId: "plan-1", approved: true },
    })

    expect(response.statusCode).toBe(404)
  })

  it.each<[string, unknown]>([
    ["requestId is missing", { approved: true }],
    ["approved is not a boolean", { requestId: "plan-1", approved: "yes" }],
    ["selectedAction is not a string", { requestId: "plan-1", approved: true, selectedAction: 1 }],
    ["feedback is not a string", { requestId: "plan-1", approved: true, feedback: 1 }],
  ])("returns 400 when %s", async (_label, body) => {
    const { response } = await invoke(
      register(registryOf([fakeRuntime("copilot")]), planClient([plan])),
      { method: "POST", url: "/copilot-1/plan", body },
    )
    expect(response.statusCode).toBe(400)
  })
})

describe("unmatched requests", () => {
  it.each<ApprovalDecision[]>([[]])("delegates to next()", async () => {
    const { next } = await invoke(register(registryOf([fakeRuntime("claude")])), {
      method: "DELETE",
      url: "/session-1",
    })
    expect(next).toHaveBeenCalled()
  })
})
