// @vitest-environment node
import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"
import type { Middleware, UseFn } from "../../helpers"
import type { PendingApproval } from "../../codex-app-server"

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
  registerPermissionRoutes,
  type CodexApprovalClient,
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
    respondApproval: vi.fn().mockResolvedValue(undefined),
  }
}

function register(codex: CodexApprovalClient): Middleware {
  let handler: Middleware | undefined
  const use: UseFn = (_path, registered) => {
    handler = registered
  }
  registerPermissionRoutes(use, codex)
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
    expect(listed.response.json()).toEqual({ permissions: [sdkRequest] })

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
