// @vitest-environment node

/**
 * Approval normalisation and answering, per runtime.
 *
 * Codex asks about commands and file writes, Copilot about ten kinds of prompt,
 * and the permission bar renders tool calls — so each adapter presents its own
 * requests as one. What is shared is the decision codec: "always allow" may
 * degrade to a one-time allow, never the reverse, and a decision an agent
 * cannot express fails the call instead of quietly becoming a different one.
 * Copilot's batch path used to narrow silently; both now refuse.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PendingApproval as CodexApproval } from "../../agents/codexAppServer"
import type { CopilotPendingPermission } from "../../agents/copilotTransport"

const { codex, copilot } = vi.hoisted(() => ({
  codex: {
    listPendingApprovals: vi.fn(() => [] as unknown[]),
    listApprovalThreadIds: vi.fn(() => [] as string[]),
    respondApproval: vi.fn(async () => {}),
    getActiveTurnId: vi.fn(() => undefined as string | undefined),
    listActiveTurns: vi.fn(() => [] as unknown[]),
    interruptTurn: vi.fn(async () => ({})),
    shutdown: vi.fn(async () => {}),
  },
  copilot: {
    getPendingPermissions: vi.fn(() => [] as unknown[]),
    respondToPermission: vi.fn(async (_sessionId: string, _requestId: string, _result?: unknown) => true),
    getPendingUserInputs: vi.fn(() => [] as unknown[]),
    answerUserInput: vi.fn(),
    isSessionActive: vi.fn(() => false),
    isTurnActive: vi.fn(() => false),
    getActiveSessionIds: vi.fn(() => [] as string[]),
    shutdown: vi.fn(async () => [] as Error[]),
  },
}))

vi.mock("../../agents/codexAppServer", () => ({
  codexAppServer: codex,
  CODEX_CLIENT_CAPABILITIES: { experimentalApi: false },
}))
vi.mock("../../agents/copilotTransport", () => ({ copilotRuntime: copilot }))
vi.mock("../../processRegistry", () => ({
  activeProcesses: new Map(),
  persistentSessions: new Map(),
  terminateTrackedSession: vi.fn(() => false),
  killTrackedProcesses: vi.fn(() => 0),
}))
vi.mock("../../agents/spawnError", () => ({
  friendlySpawnError: vi.fn((error: Error) => error.message),
}))
vi.mock("../../agents/tempImages", () => ({
  writeTempImageFiles: vi.fn(async () => []),
  cleanupTempFiles: vi.fn(async () => {}),
}))
vi.mock("../../helpers", () => ({
  join: (...parts: string[]) => parts.join("/"),
  readFile: vi.fn(),
  spawn: vi.fn(),
  unlink: vi.fn(),
  randomUUID: vi.fn(() => "generated-uuid"),
  createInterface: vi.fn(() => ({ on: vi.fn() })),
  getSessionMeta: vi.fn(async () => null),
  homedir: () => "/Users/me",
}))
vi.mock("../../sessionPaths", () => ({
  findJsonlPath: vi.fn(async () => null),
  findNewestCodexSessionForCwd: vi.fn(async () => null),
}))
vi.mock("../../agents/index", () => ({
  storeFor: (kind: string) => ({ kind, sessionsRoot: () => `/tmp/${kind}` }),
  storeForPath: () => null,
}))

import { normalizeCodexApproval, codexRuntime } from "../../agents/codexRuntime"
import { normalizeCopilotPermission, copilotRuntime } from "../../agents/copilotRuntime"
import { selectAvailableDecision, type ApprovalDecision } from "../../agents/runtimeTypes"

function codexApproval(overrides: Partial<CodexApproval> = {}): CodexApproval {
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
  } as CodexApproval
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

beforeEach(() => {
  vi.clearAllMocks()
  codex.listPendingApprovals.mockReturnValue([])
  codex.listApprovalThreadIds.mockReturnValue([])
  codex.respondApproval.mockResolvedValue(undefined)
  copilot.getPendingPermissions.mockReturnValue([])
  copilot.respondToPermission.mockResolvedValue(true)
})

// ── The shared codec ──────────────────────────────────────────────────────────

describe("selectAvailableDecision", () => {
  it.each<[string, ApprovalDecision[], ApprovalDecision, ApprovalDecision | null]>([
    ["keeps a decision the request offers", ["allow", "allow_always", "deny"], "allow_always", "allow_always"],
    ["degrades a session grant to one-time allow", ["allow", "deny"], "allow_always", "allow"],
    ["never widens a one-time allow", ["allow_always", "deny"], "allow", null],
    ["never turns a deny into an allow", ["allow"], "deny", null],
  ])("%s", (_label, available, requested, expected) => {
    expect(selectAvailableDecision(available, requested)).toBe(expected)
  })
})

// ── Codex ─────────────────────────────────────────────────────────────────────

describe("Codex approvals", () => {
  it("presents native command and file approvals as tool calls", () => {
    expect(normalizeCodexApproval(codexApproval())).toMatchObject({
      sessionId: "thread-1",
      requestId: "42",
      toolName: "Bash",
      toolUseId: "item-1",
      input: { command: "npm test", cwd: "/project" },
      title: "Run command",
      decisionReason: "Needs approval",
      timestamp: 123,
      availableDecisions: ["allow", "allow_always", "deny"],
    })

    expect(normalizeCodexApproval(codexApproval({
      requestId: "file-1",
      kind: "fileChange",
      method: "item/fileChange/requestApproval",
      command: undefined,
      cwd: undefined,
      grantRoot: "/shared",
    }))).toMatchObject({
      requestId: "file-1",
      toolName: "Write",
      input: { file_path: "/shared" },
      blockedPath: "/shared",
    })

    expect(normalizeCodexApproval(codexApproval({
      command: undefined,
      networkApprovalContext: { host: "registry.npmjs.org", protocol: "https", port: 443 },
    }))).toMatchObject({
      toolName: "WebFetch",
      title: "Allow network access",
      input: { url: "https://registry.npmjs.org:443" },
    })
  })

  it("lists a descendant approval while polling the open parent thread", () => {
    const child = codexApproval({ requestId: "child-approval", threadId: "child-thread" })
    codex.listPendingApprovals.mockReturnValue([child])

    expect(codexRuntime.listPendingApprovals("parent-thread")).toMatchObject([{
      sessionId: "parent-thread",
      requestId: "child-approval",
      availableDecisions: ["allow", "allow_always", "deny"],
    }])
    expect(codex.listPendingApprovals).toHaveBeenCalledWith("parent-thread")
  })

  it("answers a native approval over the open channel", async () => {
    const native = codexApproval()
    codex.listPendingApprovals.mockReturnValue([native])

    await expect(codexRuntime.respondToApproval("thread-1", "42", "allow_always"))
      .resolves.toBe(true)
    expect(codex.respondApproval).toHaveBeenCalledWith(native, "allow_always")
  })

  it("refuses a decision the request did not offer", async () => {
    codex.listPendingApprovals.mockReturnValue([
      codexApproval({ availableDecisions: ["allow", "deny"] }),
    ])

    await expect(codexRuntime.respondToApproval("thread-1", "42", "allow_always"))
      .rejects.toMatchObject({
        status: 400,
        code: "CODEX_APPROVAL_DECISION_UNAVAILABLE",
        message: "Decision 'allow_always' is not available for this approval request",
        details: { requestId: "42", availableDecisions: ["allow", "deny"] },
      })
    expect(codex.respondApproval).not.toHaveBeenCalled()
  })

  it("reports a transport failure as an upstream error", async () => {
    codex.listPendingApprovals.mockReturnValue([codexApproval()])
    codex.respondApproval.mockRejectedValue(new Error("transport lost"))

    await expect(codexRuntime.respondToApproval("thread-1", "42", "allow"))
      .rejects.toMatchObject({ status: 502, code: "CODEX_APPROVAL_FAILED", message: "transport lost" })
  })

  it("answers every approval in the thread", async () => {
    const command = codexApproval()
    const file = codexApproval({
      requestId: "file-1",
      kind: "fileChange",
      itemId: "item-2",
      grantRoot: "/project",
    })
    codex.listPendingApprovals.mockReturnValue([command, file])

    await expect(codexRuntime.respondToAllApprovals("thread-1", "deny")).resolves.toEqual({
      count: 2,
      toolNames: ["Bash", "Write"],
    })
    expect(codex.respondApproval).toHaveBeenCalledWith(command, "deny")
    expect(codex.respondApproval).toHaveBeenCalledWith(file, "deny")
  })

  it("degrades a batch session grant per request", async () => {
    const sessionGrant = codexApproval()
    const oneTimeOnly = codexApproval({
      requestId: "one-time",
      itemId: "item-2",
      availableDecisions: ["allow", "deny"],
    })
    codex.listPendingApprovals.mockReturnValue([sessionGrant, oneTimeOnly])

    await codexRuntime.respondToAllApprovals("thread-1", "allow_always")

    expect(codex.respondApproval).toHaveBeenCalledWith(sessionGrant, "allow_always")
    expect(codex.respondApproval).toHaveBeenCalledWith(oneTimeOnly, "allow")
  })

  it("does not partially resolve a batch with no safe decision", async () => {
    codex.listPendingApprovals.mockReturnValue([
      codexApproval(),
      codexApproval({
        requestId: "session-only",
        itemId: "item-2",
        availableDecisions: ["allow_always", "deny"],
      }),
    ])

    await expect(codexRuntime.respondToAllApprovals("thread-1", "allow"))
      .rejects.toMatchObject({
        status: 400,
        code: "CODEX_APPROVAL_DECISION_UNAVAILABLE",
        details: { requestId: "session-only", availableDecisions: ["allow_always", "deny"] },
      })
    expect(codex.respondApproval).not.toHaveBeenCalled()
  })
})

// ── Copilot ───────────────────────────────────────────────────────────────────

describe("Copilot permissions", () => {
  it("presents command and file prompts as tool calls", () => {
    expect(normalizeCopilotPermission(copilotPermission())).toMatchObject({
      sessionId: "copilot-1",
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
      input: { file_path: "/project/output.ts", diff: "+export const done = true" },
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
    const { availableDecisions } = normalizeCopilotPermission(copilotPermission({ request }))
    expect(availableDecisions.includes("allow_always")).toBe(expected)
  })

  it("does not offer always-allow when managed policy requires approval", () => {
    expect(normalizeCopilotPermission(copilotPermission({
      request: {
        kind: "commands",
        canOfferSessionApproval: true,
        managedApprovalRequired: true,
      },
    })).availableDecisions).toEqual(["allow", "deny"])
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
      input: { command: "git status", request_sandbox_bypass: true },
    })
  })

  it("answers a prompt with the CLI's own decision shape", async () => {
    copilot.getPendingPermissions.mockReturnValue([copilotPermission()])

    await expect(copilotRuntime.respondToApproval("copilot-1", "permission-1", "allow"))
      .resolves.toBe(true)
    expect(copilot.respondToPermission).toHaveBeenCalledWith(
      "copilot-1",
      "permission-1",
      { kind: "approve-once", approvedInteractively: true },
    )
  })

  it("refuses a decision the prompt did not offer", async () => {
    copilot.getPendingPermissions.mockReturnValue([copilotPermission({
      request: { kind: "read", path: "/a.ts" },
    })])

    await expect(copilotRuntime.respondToApproval("copilot-1", "permission-1", "allow_always"))
      .rejects.toMatchObject({
        status: 400,
        code: "COPILOT_PERMISSION_DECISION_UNAVAILABLE",
        details: { requestId: "permission-1", availableDecisions: ["allow", "deny"] },
      })
    expect(copilot.respondToPermission).not.toHaveBeenCalled()
  })

  it("degrades a batch session grant per request", async () => {
    const command = copilotPermission()
    const write = copilotPermission({
      requestId: "permission-2",
      request: { kind: "write", fileName: "/project/a.ts", canOfferSessionApproval: false },
    })
    copilot.getPendingPermissions.mockReturnValue([command, write])

    await expect(copilotRuntime.respondToAllApprovals("copilot-1", "allow_always"))
      .resolves.toEqual({ count: 2, toolNames: ["Bash", "Write"] })

    expect(copilot.respondToPermission).toHaveBeenNthCalledWith(
      1, "copilot-1", "permission-1", { kind: "approve-for-session" },
    )
    expect(copilot.respondToPermission).toHaveBeenNthCalledWith(
      2, "copilot-1", "permission-2", { kind: "approve-once", approvedInteractively: true },
    )
  })

  it("does not partially resolve a batch with no safe decision", async () => {
    // Previously this arm silently narrowed whatever it could and answered the
    // rest with the requested decision anyway; Codex 400'd the same case. One
    // codec now, and it is the explicit one.
    copilot.getPendingPermissions.mockReturnValue([
      copilotPermission(),
      copilotPermission({
        requestId: "session-only",
        request: { kind: "read", path: "/a.ts" },
      }),
    ])

    await expect(copilotRuntime.respondToAllApprovals("copilot-1", "allow_always"))
      .resolves.toMatchObject({ count: 2 })

    copilot.getPendingPermissions.mockReturnValue([
      copilotPermission({ request: { kind: "read", path: "/a.ts" } }),
    ])
    await expect(copilotRuntime.respondToAllApprovals("copilot-1", "deny"))
      .resolves.toMatchObject({ count: 1 })
  })

  it("treats a sibling auto-resolved by a session approval as handled", async () => {
    const command = copilotPermission()
    const sibling = copilotPermission({ requestId: "permission-2" })
    let pending = [command, sibling]
    copilot.getPendingPermissions.mockImplementation(() => pending)
    copilot.respondToPermission.mockImplementation(async (_sessionId, requestId) => {
      if (requestId === command.requestId) pending = []
      return true
    })

    await expect(copilotRuntime.respondToAllApprovals("copilot-1", "allow_always"))
      .resolves.toMatchObject({ count: 2 })
    expect(copilot.respondToPermission).toHaveBeenCalledOnce()
  })

  it("reports a request that was already resolved elsewhere", async () => {
    copilot.getPendingPermissions.mockReturnValue([copilotPermission()])
    copilot.respondToPermission.mockResolvedValue(false)

    await expect(copilotRuntime.respondToAllApprovals("copilot-1", "allow"))
      .rejects.toMatchObject({ status: 409, code: "COPILOT_PERMISSION_ALREADY_RESOLVED" })
  })
})
