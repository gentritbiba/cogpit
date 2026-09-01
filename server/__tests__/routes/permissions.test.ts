// @vitest-environment node
import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import type { PendingApproval } from "../../codex-app-server"
import type { CopilotPendingExitPlan, CopilotPendingPermission } from "../../copilot-runtime"

const {
  mockPersistentSessions,
  mockActiveProcesses,
  mockSdkSessions,
  mockGetSDKPermissions,
  mockResolvePermission,
  mockResolveAllPermissions,
} = vi.hoisted(() => ({
  mockPersistentSessions: new Map<string, unknown>(),
  mockActiveProcesses: new Map<string, unknown>(),
  mockSdkSessions: new Map<string, unknown>(),
  mockGetSDKPermissions: vi.fn((..._args: unknown[]): unknown[] => []),
  mockResolvePermission: vi.fn((..._args: unknown[]): unknown => undefined),
  mockResolveAllPermissions: vi.fn((..._args: unknown[]): unknown => undefined),
}))

vi.mock("../../helpers", () => ({
  persistentSessions: mockPersistentSessions,
  activeProcesses: mockActiveProcesses,
  sendJson: (res: FakeResponse, status: number, data: unknown) => {
    res.statusCode = status
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(data))
  },
}))

vi.mock("../../sdk-session", () => ({
  sdkSessions: mockSdkSessions,
  getSDKPermissions: (...args: unknown[]) => mockGetSDKPermissions(...args),
  resolvePermission: (...args: unknown[]) => mockResolvePermission(...args),
  resolveAllPermissions: (...args: unknown[]) =>
    mockResolveAllPermissions(...args),
}))

import {
  normalizeCodexApproval,
  normalizeCopilotPermission,
  registerPermissionRoutes,
  type CodexApprovalClient,
  type CopilotPermissionClient,
} from "../../routes/permissions"

interface FakeResponse {
  statusCode: number
  setHeader: Mock<(name: string, value: string) => void>
  end: Mock<(value?: string) => void>
  json: () => unknown
}

function approval(
  overrides: Partial<PendingApproval> = {},
): PendingApproval {
  return {
    requestId: 42,
    kind: "commandExecution",
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    requestedAt: 123,
    reason: "Needs approval",
    command: "npm test",
    cwd: "/project",
    availableDecisions: ["allow", "allow_always", "deny"],
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      command: "npm test",
      cwd: "/project",
    },
    ...overrides,
  }
}

function makeCodex(pending: PendingApproval[] = []): CodexApprovalClient {
  return {
    listPendingApprovals: vi.fn((threadId: string) =>
      pending.filter((item) => item.threadId === threadId),
    ),
    listApprovalThreadIds: vi.fn(() => [...new Set(pending.map((item) => item.threadId))]),
    respondApproval: vi.fn().mockResolvedValue(undefined),
  }
}

function copilotPermission(
  overrides: Partial<CopilotPendingPermission> = {},
): CopilotPendingPermission {
  return {
    sessionId: "copilot-1",
    requestId: "permission-1",
    requestedAt: 456,
    request: {
      kind: "commands",
      fullCommandText: "bun test",
      intention: "Run the test suite",
      toolCallId: "tool-1",
      canOfferSessionApproval: true,
    },
    ...overrides,
  }
}

function makeCopilot(
  pending: CopilotPendingPermission[] = [],
  plans: CopilotPendingExitPlan[] = [],
): CopilotPermissionClient {
  return {
    getPendingPermissions: vi.fn((sessionId?: string) =>
      sessionId === undefined
        ? pending
        : pending.filter((item) => item.sessionId === sessionId),
    ),
    respondToPermission: vi.fn().mockResolvedValue(true),
    getPendingExitPlans: vi.fn((sessionId?: string) =>
      sessionId === undefined
        ? plans
        : plans.filter((item) => item.sessionId === sessionId),
    ),
    answerExitPlan: vi.fn(),
  }
}

function register(
  codex: CodexApprovalClient,
  copilot: CopilotPermissionClient = makeCopilot(),
): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (_path, registered) => {
    handler = registered
  }
  registerPermissionRoutes(use, codex, copilot)
  if (!handler) throw new Error("Permission route was not registered")
  return handler
}

async function invoke(
  handler: Middleware,
  options: { method: string; url: string; body?: unknown },
): Promise<{ response: FakeResponse; next: ReturnType<typeof vi.fn> }> {
  const req = new EventEmitter() as EventEmitter & {
    method: string
    url: string
  }
  req.method = options.method
  req.url = options.url
  let payload = ""
  const response: FakeResponse = {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn((value?: string) => {
      payload = value ?? ""
    }),
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
  mockActiveProcesses.clear()
  mockSdkSessions.clear()
  mockGetSDKPermissions.mockReset().mockReturnValue([])
  mockResolvePermission.mockReset()
  mockResolveAllPermissions.mockReset()
})

describe("Codex permission fallback", () => {
  it("normalizes native command and file approvals for the existing UI", () => {
    expect(normalizeCodexApproval(approval())).toMatchObject({
      requestId: "42",
      toolName: "Bash",
      toolUseId: "item-1",
      input: { command: "npm test", cwd: "/project" },
      title: "Run command",
      decisionReason: "Needs approval",
      timestamp: 123,
      availableDecisions: ["allow", "allow_always", "deny"],
    })
    expect(
      normalizeCodexApproval(
        approval({
          requestId: "file-1",
          kind: "fileChange",
          method: "item/fileChange/requestApproval",
          command: undefined,
          cwd: undefined,
          grantRoot: "/shared",
        }),
      ),
    ).toMatchObject({
      requestId: "file-1",
      toolName: "Write",
      input: { file_path: "/shared" },
      blockedPath: "/shared",
    })

    expect(
      normalizeCodexApproval(
        approval({
          command: undefined,
          networkApprovalContext: {
            host: "registry.npmjs.org",
            protocol: "https",
            port: 443,
          },
        }),
      ),
    ).toMatchObject({
      toolName: "WebFetch",
      title: "Allow network access",
      input: { url: "https://registry.npmjs.org:443" },
    })
  })

  it("lists app-server approvals before the legacy Codex fallback", async () => {
    const native = approval()
    const codex = makeCodex([native])
    mockPersistentSessions.set("thread-1", {
      pendingPermissions: new Map([
        ["legacy", { requestId: "legacy", toolName: "Bash" }],
      ]),
    })
    const { response } = await invoke(register(codex), {
      method: "GET",
      url: "/thread-1",
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      permissions: [{ requestId: "42", toolName: "Bash" }],
    })
  })

  it("lists a descendant approval while polling the open parent thread", async () => {
    const childApproval = approval({
      requestId: "child-approval",
      threadId: "child-thread",
    })
    const codex = makeCodex()
    vi.mocked(codex.listPendingApprovals).mockReturnValue([childApproval])
    const { response } = await invoke(register(codex), {
      method: "GET",
      url: "/parent-thread",
    })

    expect(codex.listPendingApprovals).toHaveBeenCalledWith("parent-thread")
    expect(response.json()).toMatchObject({
      permissions: [
        {
          requestId: "child-approval",
          availableDecisions: ["allow", "allow_always", "deny"],
        },
      ],
    })
  })

  it("responds to a native approval without killing or retrying the session", async () => {
    const native = approval()
    const codex = makeCodex([native])
    const kill = vi.fn()
    mockPersistentSessions.set("thread-1", {
      pendingPermissions: new Map(),
      proc: { kill },
      dead: false,
    })
    const { response } = await invoke(register(codex), {
      method: "POST",
      url: "/thread-1/respond",
      body: { requestId: "42", behavior: "allow_always" },
    })

    expect(codex.respondApproval).toHaveBeenCalledWith(native, "allow_always")
    expect(response.json()).toEqual({
      success: true,
      action: "allowed",
      toolName: "Bash",
      shouldRetry: false,
    })
    expect(kill).not.toHaveBeenCalled()
  })

  it("rejects a native decision that the request did not offer", async () => {
    const native = approval({ availableDecisions: ["allow", "deny"] })
    const codex = makeCodex([native])
    const { response } = await invoke(register(codex), {
      method: "POST",
      url: "/thread-1/respond",
      body: { requestId: "42", behavior: "allow_always" },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({
      error: "Decision 'allow_always' is not available for this approval request",
      code: "CODEX_APPROVAL_DECISION_UNAVAILABLE",
      requestId: "42",
      availableDecisions: ["allow", "deny"],
    })
    expect(codex.respondApproval).not.toHaveBeenCalled()
  })

  it("responds to all native approvals in the thread", async () => {
    const command = approval()
    const file = approval({
      requestId: "file-1",
      kind: "fileChange",
      method: "item/fileChange/requestApproval",
      itemId: "item-2",
      grantRoot: "/project",
    })
    const codex = makeCodex([command, file])
    const { response } = await invoke(register(codex), {
      method: "POST",
      url: "/thread-1/respond-all",
      body: { behavior: "deny" },
    })

    expect(codex.respondApproval).toHaveBeenCalledTimes(2)
    expect(codex.respondApproval).toHaveBeenCalledWith(command, "deny")
    expect(codex.respondApproval).toHaveBeenCalledWith(file, "deny")
    expect(response.json()).toEqual({
      success: true,
      action: "denied",
      count: 2,
      toolNames: ["Bash", "Write"],
      shouldRetry: false,
    })
  })

  it("degrades respond-all session grants to one-time allow per request", async () => {
    const sessionGrant = approval()
    const oneTimeOnly = approval({
      requestId: "one-time",
      itemId: "item-2",
      availableDecisions: ["allow", "deny"],
    })
    const codex = makeCodex([sessionGrant, oneTimeOnly])
    const { response } = await invoke(register(codex), {
      method: "POST",
      url: "/thread-1/respond-all",
      body: { behavior: "allow_always" },
    })

    expect(response.statusCode).toBe(200)
    expect(codex.respondApproval).toHaveBeenCalledWith(
      sessionGrant,
      "allow_always",
    )
    expect(codex.respondApproval).toHaveBeenCalledWith(oneTimeOnly, "allow")
  })

  it("does not partially resolve a batch with no safe decision", async () => {
    const allowed = approval()
    const sessionOnly = approval({
      requestId: "session-only",
      itemId: "item-2",
      availableDecisions: ["allow_always", "deny"],
    })
    const codex = makeCodex([allowed, sessionOnly])
    const { response } = await invoke(register(codex), {
      method: "POST",
      url: "/thread-1/respond-all",
      body: { behavior: "allow" },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      code: "CODEX_APPROVAL_DECISION_UNAVAILABLE",
      requestId: "session-only",
      availableDecisions: ["allow_always", "deny"],
    })
    expect(codex.respondApproval).not.toHaveBeenCalled()
  })

  it("preserves the Claude SDK path ahead of provider fallbacks", async () => {
    const codex = makeCodex([approval()])
    const sdkRequest = {
      requestId: "sdk-1",
      toolName: "Read",
      input: {},
      toolUseId: "tool-1",
      timestamp: 1,
    }
    mockSdkSessions.set("thread-1", {})
    mockGetSDKPermissions.mockReturnValue([sdkRequest])
    mockResolvePermission.mockReturnValue({ found: true, toolName: "Read" })

    const listed = await invoke(register(codex), {
      method: "GET",
      url: "/thread-1",
    })
    expect(listed.response.json()).toEqual({ permissions: [sdkRequest], plan: null })

    const responded = await invoke(register(codex), {
      method: "POST",
      url: "/thread-1/respond",
      body: { requestId: "sdk-1", behavior: "allow" },
    })
    expect(responded.response.statusCode).toBe(200)
    expect(mockResolvePermission).toHaveBeenCalledWith(
      "thread-1",
      "sdk-1",
      "allow",
    )
    expect(codex.respondApproval).not.toHaveBeenCalled()
  })

  it("returns a structured upstream error if app-server cannot respond", async () => {
    const codex = makeCodex([approval()])
    vi.mocked(codex.respondApproval).mockRejectedValue(new Error("transport lost"))
    const { response } = await invoke(register(codex), {
      method: "POST",
      url: "/thread-1/respond",
      body: { requestId: "42", behavior: "allow" },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({
      error: "transport lost",
      code: "CODEX_APPROVAL_FAILED",
    })
  })
})

describe("Copilot permissions", () => {
  it("normalizes command and file prompts for the existing UI", () => {
    expect(normalizeCopilotPermission(copilotPermission())).toMatchObject({
      requestId: "permission-1",
      toolName: "Bash",
      toolUseId: "tool-1",
      input: { command: "bun test" },
      title: "Run command",
      description: "Run the test suite",
      timestamp: 456,
      availableDecisions: ["allow", "allow_always", "deny"],
    })
    expect(normalizeCopilotPermission(copilotPermission({
      request: {
        kind: "write",
        fileName: "/project/output.ts",
        intention: "Update output",
        diff: "+export const done = true",
        canOfferSessionApproval: false,
      },
    }))).toMatchObject({
      toolName: "Write",
      input: {
        file_path: "/project/output.ts",
        diff: "+export const done = true",
      },
      blockedPath: "/project/output.ts",
      availableDecisions: ["allow", "deny"],
    })
  })

  it.each([
    ["commands with session approval", { kind: "commands", canOfferSessionApproval: true }, true],
    ["commands without session approval", { kind: "commands", canOfferSessionApproval: false }, false],
    ["commands without a capability", { kind: "commands" }, false],
    ["shell with session approval", { kind: "shell", canOfferSessionApproval: true }, true],
    ["write with session approval", { kind: "write", canOfferSessionApproval: true }, true],
    ["factory with persistent approval", { kind: "factory", canPersistApproval: true }, true],
    ["factory without persistent approval", { kind: "factory", canPersistApproval: false }, false],
    ["MCP with its legacy default", { kind: "mcp" }, true],
    ["MCP with server-wide approval disabled", { kind: "mcp", canOfferServerWideApproval: false }, false],
    ["read without an approval capability", { kind: "read" }, false],
    ["an unrelated kind with a generic capability", { kind: "custom-tool", canOfferSessionApproval: true }, false],
  ])("gates always-allow for %s", (_label, request, expected) => {
    const decisions = normalizeCopilotPermission(copilotPermission({ request }))
      .availableDecisions
    expect(decisions.includes("allow_always")).toBe(expected)
  })

  it("does not offer always-allow when managed policy requires approval", () => {
    const decisions = normalizeCopilotPermission(copilotPermission({
      request: {
        kind: "commands",
        canOfferSessionApproval: true,
        managedApprovalRequired: true,
      },
    })).availableDecisions

    expect(decisions).toEqual(["allow", "deny"])
  })

  it("makes sandbox-bypass risk explicit", () => {
    expect(normalizeCopilotPermission(copilotPermission({
      request: {
        kind: "read",
        path: "/outside/project/secrets.txt",
        intention: "Inspect a file",
        warning: "This read bypasses the project sandbox",
        requestSandboxBypass: true,
        requestSandboxBypassReason: "The path is outside the workspace",
      },
    }))).toMatchObject({
      title: "Read file outside sandbox",
      description: "This read bypasses the project sandbox",
      decisionReason: "This read bypasses the project sandbox",
      blockedPath: "/outside/project/secrets.txt",
      input: {
        file_path: "/outside/project/secrets.txt",
        request_sandbox_bypass: true,
      },
    })
  })

  it("preserves sandbox-bypass risk from the raw shell request", () => {
    expect(normalizeCopilotPermission(copilotPermission({
      request: {
        kind: "commands",
        fullCommandText: "git status",
        intention: "Inspect the repository",
        canOfferSessionApproval: true,
      },
      rawRequest: {
        kind: "shell",
        fullCommandText: "git status",
        requestSandboxBypass: true,
        requestSandboxBypassReason: "Git needs access outside the workspace",
      },
    }))).toMatchObject({
      title: "Run command outside sandbox",
      description: "Git needs access outside the workspace",
      decisionReason: "Git needs access outside the workspace",
      input: {
        command: "git status",
        request_sandbox_bypass: true,
      },
    })
  })

  it("lists Copilot prompts before the legacy fallback", async () => {
    const copilot = makeCopilot([copilotPermission()])
    mockPersistentSessions.set("copilot-1", {
      pendingPermissions: new Map([
        ["legacy", { requestId: "legacy", toolName: "Bash" }],
      ]),
    })

    const { response } = await invoke(register(makeCodex(), copilot), {
      method: "GET",
      url: "/copilot-1",
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      permissions: [{ requestId: "permission-1", toolName: "Bash" }],
    })
  })

  it("responds directly without killing or retrying", async () => {
    const pending = copilotPermission()
    const copilot = makeCopilot([pending])
    const kill = vi.fn()
    mockPersistentSessions.set("copilot-1", {
      pendingPermissions: new Map(),
      proc: { kill },
      dead: false,
    })

    const { response } = await invoke(register(makeCodex(), copilot), {
      method: "POST",
      url: "/copilot-1/respond",
      body: { requestId: "permission-1", behavior: "allow" },
    })

    expect(copilot.respondToPermission).toHaveBeenCalledWith(
      "copilot-1",
      "permission-1",
      { kind: "approve-once", approvedInteractively: true },
    )
    expect(response.json()).toEqual({
      success: true,
      action: "allowed",
      toolName: "Bash",
      shouldRetry: false,
    })
    expect(kill).not.toHaveBeenCalled()
  })

  it("resolves a Copilot batch directly and safely narrows unsupported session grants", async () => {
    const command = copilotPermission()
    const write = copilotPermission({
      requestId: "permission-2",
      request: {
        kind: "write",
        fileName: "/project/a.ts",
        canOfferSessionApproval: false,
      },
    })
    const copilot = makeCopilot([command, write])

    const { response } = await invoke(register(makeCodex(), copilot), {
      method: "POST",
      url: "/copilot-1/respond-all",
      body: { behavior: "allow_always" },
    })

    expect(copilot.respondToPermission).toHaveBeenNthCalledWith(
      1,
      "copilot-1",
      "permission-1",
      { kind: "approve-for-session" },
    )
    expect(copilot.respondToPermission).toHaveBeenNthCalledWith(
      2,
      "copilot-1",
      "permission-2",
      { kind: "approve-once", approvedInteractively: true },
    )
    expect(response.json()).toEqual({
      success: true,
      action: "allowed",
      count: 2,
      toolNames: ["Bash", "Write"],
      shouldRetry: false,
    })
  })

  it("treats sibling requests auto-resolved by a session approval as handled", async () => {
    const command = copilotPermission()
    const sibling = copilotPermission({ requestId: "permission-2" })
    let pending = [command, sibling]
    const copilot = makeCopilot(pending)
    vi.mocked(copilot.getPendingPermissions).mockImplementation((sessionId?: string) =>
      sessionId === undefined ? pending : pending.filter((item) => item.sessionId === sessionId),
    )
    vi.mocked(copilot.respondToPermission).mockImplementation(async (_sessionId, requestId) => {
      if (requestId === command.requestId) pending = []
      return true
    })

    const { response } = await invoke(register(makeCodex(), copilot), {
      method: "POST",
      url: "/copilot-1/respond-all",
      body: { behavior: "allow_always" },
    })

    expect(response.statusCode).toBe(200)
    expect(copilot.respondToPermission).toHaveBeenCalledOnce()
    expect(response.json()).toMatchObject({ success: true, count: 2 })
  })

  it("lists and resolves Copilot exit-plan requests", async () => {
    const plan: CopilotPendingExitPlan = {
      sessionId: "copilot-1",
      requestId: "plan-1",
      summary: "Implementation plan",
      planContent: "1. Update the route",
      actions: ["interactive", "autopilot"],
      recommendedAction: "interactive",
      askedAt: 123,
    }
    const copilot = makeCopilot([], [plan])
    const listed = await invoke(register(makeCodex(), copilot), {
      method: "GET",
      url: "/copilot-1",
    })
    expect(listed.response.json()).toEqual({ permissions: [], plan })

    const responded = await invoke(register(makeCodex(), copilot), {
      method: "POST",
      url: "/copilot-1/plan",
      body: {
        requestId: "plan-1",
        approved: true,
        selectedAction: "autopilot",
      },
    })
    expect(responded.response.statusCode).toBe(200)
    expect(copilot.answerExitPlan).toHaveBeenCalledWith(
      "copilot-1",
      "plan-1",
      { approved: true, selectedAction: "autopilot" },
    )
  })
})

describe("GET /api/permissions — cross-session listing", () => {
  beforeEach(() => {
    mockPersistentSessions.clear()
    mockSdkSessions.clear()
    mockGetSDKPermissions.mockReset().mockReturnValue([])
  })

  it("groups pending requests from every provider by session", async () => {
    // Mission Control renders cards for sessions that are not open, so it needs
    // one call that covers all of them rather than a poll per session.
    mockSdkSessions.set("sdk-session", {})
    mockGetSDKPermissions.mockImplementation((sessionId: unknown) =>
      sessionId === "sdk-session"
        ? [{ requestId: "r1", toolName: "Bash", input: {}, toolUseId: "r1", timestamp: 1 }]
        : [],
    )
    const codex = makeCodex([approval({ threadId: "codex-thread" })])

    const copilot = makeCopilot([copilotPermission()])
    const { response } = await invoke(register(codex, copilot), { method: "GET", url: "" })

    expect(response.statusCode).toBe(200)
    const body = response.json() as { bySession: Record<string, unknown[]> }
    expect(Object.keys(body.bySession).sort()).toEqual([
      "codex-thread",
      "copilot-1",
      "sdk-session",
    ])
    expect(body.bySession["sdk-session"]).toHaveLength(1)
    expect(body.bySession["codex-thread"]).toHaveLength(1)
    expect(body.bySession["copilot-1"]).toHaveLength(1)
  })

  it("includes legacy CLI sessions that have pending permissions", async () => {
    mockPersistentSessions.set("legacy", {
      pendingPermissions: new Map([["r9", { requestId: "r9", toolName: "Write" }]]),
    })

    const { response } = await invoke(register(makeCodex()), { method: "GET", url: "" })

    const body = response.json() as { bySession: Record<string, unknown[]> }
    expect(body.bySession.legacy).toHaveLength(1)
  })

  it("omits sessions with nothing pending", async () => {
    mockSdkSessions.set("quiet", {})

    const { response } = await invoke(register(makeCodex()), { method: "GET", url: "" })

    expect(response.json()).toEqual({ bySession: {}, plansBySession: {} })
  })

  it("answers the bare path even with a query string", async () => {
    const { response } = await invoke(register(makeCodex()), { method: "GET", url: "?x=1" })
    expect(response.statusCode).toBe(200)
  })
})

describe("GET /api/permissions — payload shape", () => {
  beforeEach(() => {
    mockPersistentSessions.clear()
    mockSdkSessions.clear()
    mockGetSDKPermissions.mockReset().mockReturnValue([])
  })

  it("summarises requests instead of shipping the raw tool input", async () => {
    // A pending Write carries the entire file being written, and this list is
    // polled app-wide — sending it would put that payload on the wire every few
    // seconds for every client, including remote and tunnel ones.
    const wholeFile = "x".repeat(5000)
    mockSdkSessions.set("s1", {})
    mockGetSDKPermissions.mockImplementation((sessionId: unknown) =>
      sessionId === "s1"
        ? [{
            requestId: "r1",
            toolName: "Write",
            input: { file_path: "/big.ts", content: wholeFile },
            toolUseId: "r1",
            timestamp: 7,
          }]
        : [],
    )

    const { response } = await invoke(register(makeCodex()), { method: "GET", url: "" })
    const body = response.json() as { bySession: Record<string, Record<string, unknown>[]> }
    const [request] = body.bySession.s1

    expect(request).toEqual({
      sessionId: "s1",
      requestId: "r1",
      toolName: "Write",
      summary: "/big.ts",
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
    const { response } = await invoke(register(makeCodex(), makeCopilot([], [plan])), {
      method: "GET",
      url: "",
    })

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
