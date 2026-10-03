// @vitest-environment node

/**
 * One suite, run against all three runtimes.
 *
 * The three adapters wrap unrelated transports — an in-process SDK query, a
 * JSONL app-server, a JSON-RPC session server — but every route now talks to
 * them through the same eleven methods, so the contract is written once and
 * parameterised. What is genuinely asymmetric gets its own block at the end:
 * Copilot owns no per-session process and deletes over RPC, Codex interrupts
 * turns where Copilot destroys sessions, and only Codex keeps a legacy CLI.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentKind } from "../../../shared/session/agent-descriptors"

const { sdk, codex, copilot, registry } = vi.hoisted(() => ({
  sdk: {
    sdkSessions: new Map<string, unknown>(),
    isSDKQueryLive: vi.fn(() => false),
    stopSDKSession: vi.fn(() => false),
    interruptSDKTurn: vi.fn(async () => false),
    cleanupAllSDKSessions: vi.fn(() => 0),
    getSDKPermissions: vi.fn(() => [] as unknown[]),
    getSDKUserQuestions: vi.fn(() => [] as unknown[]),
    listUserQuestionSessionIds: vi.fn(() => [] as string[]),
    resolvePermission: vi.fn(() => ({ found: false })),
    resolveAllPermissions: vi.fn(() => [] as unknown[]),
    resolveUserQuestion: vi.fn(() => ({ found: false })),
  },
  codex: {
    getActiveTurnId: vi.fn(() => undefined as string | undefined),
    listActiveTurns: vi.fn(() => [] as Array<{ threadId: string; turnId: string }>),
    listApprovalThreadIds: vi.fn(() => [] as string[]),
    listPendingApprovals: vi.fn(() => [] as unknown[]),
    respondApproval: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => ({})),
    shutdown: vi.fn(async () => {}),
    start: vi.fn(async () => ({})),
    call: vi.fn(async () => ({})),
  },
  copilot: {
    createSession: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    isSessionActive: vi.fn((_sessionId: string) => false),
    isTurnActive: vi.fn((_sessionId: string) => false),
    getActiveSessionIds: vi.fn(() => [] as string[]),
    getPendingPermissions: vi.fn(() => [] as unknown[]),
    getPendingUserInputs: vi.fn(() => [] as unknown[]),
    getPendingExitPlans: vi.fn((_sessionId?: string) => [] as unknown[]),
    respondToPermission: vi.fn(async () => true),
    answerUserInput: vi.fn(),
    abort: vi.fn(async () => {}),
    destroySession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => ({ success: true })),
    getAccountQuota: vi.fn(async () => ({ entitlement: 1 })),
    getSessionUsage: vi.fn(async (_sessionId: string) => ({})),
    shutdown: vi.fn(async () => [] as Error[]),
  },
  registry: {
    activeProcesses: new Map<string, unknown>(),
    persistentSessions: new Map<string, unknown>(),
    terminateTrackedSession: vi.fn(() => false),
    killTrackedProcesses: vi.fn(() => 0),
  },
}))

vi.mock("../../sdk-session", () => ({
  ...sdk,
  createSDKSession: vi.fn(),
  resumeSDKSession: vi.fn(),
  sendSDKMessage: vi.fn(),
  attachSubagentWatcher: vi.fn(),
  claudeCliPath: vi.fn(() => undefined),
}))
vi.mock("../../agents/codexAppServer", () => ({
  codexAppServer: codex,
  CODEX_CLIENT_CAPABILITIES: { experimentalApi: false },
}))
vi.mock("../../agents/copilotTransport", () => ({ copilotRuntime: copilot }))
vi.mock("../../processRegistry", () => registry)
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
  stat: vi.fn(),
  spawn: vi.fn(),
  unlink: vi.fn(async () => {}),
  randomUUID: vi.fn(() => "generated-uuid"),
  createInterface: vi.fn(() => ({ on: vi.fn() })),
  getSessionMeta: vi.fn(async () => null),
  homedir: () => "/Users/me",
  dirs: { PROJECTS_DIR: "/tmp/projects" },
}))
vi.mock("../../sessionPaths", () => ({
  findJsonlPath: vi.fn(async () => null),
  findNewestCodexSessionForCwd: vi.fn(async () => null),
}))
vi.mock("../../agents/index", () => ({
  storeFor: (kind: string) => ({
    kind,
    sessionsRoot: () => `/tmp/${kind}`,
    listSessionFiles: vi.fn(async () => []),
  }),
  storeForPath: () => null,
}))

import { unlink } from "../../helpers"
import { createSDKSession, resumeSDKSession, sendSDKMessage, type SDKSessionState } from "../../sdk-session"
import { allRuntimes, isSessionActive, runtimeFor, runtimeForDirName, runtimeForSession } from "../../agents/runtimes"

beforeEach(() => {
  vi.clearAllMocks()
  sdk.sdkSessions.clear()
  registry.activeProcesses.clear()
  registry.persistentSessions.clear()
  sdk.isSDKQueryLive.mockReturnValue(false)
  codex.getActiveTurnId.mockReturnValue(undefined)
  codex.listActiveTurns.mockReturnValue([])
  codex.listApprovalThreadIds.mockReturnValue([])
  codex.listPendingApprovals.mockReturnValue([])
  copilot.isSessionActive.mockReturnValue(false)
  copilot.isTurnActive.mockReturnValue(false)
  copilot.getActiveSessionIds.mockReturnValue([])
  copilot.getPendingPermissions.mockReturnValue([])
  copilot.getPendingUserInputs.mockReturnValue([])
  copilot.getPendingExitPlans.mockReturnValue([])
})

describe("runtime registry", () => {
  it("exposes one runtime per agent, in detection order", () => {
    expect(allRuntimes().map(({ kind }) => kind)).toEqual(["codex", "copilot", "claude"])
  })

  it("resolves a runtime from a project dirName, with Claude as the terminal arm", () => {
    for (const kind of ["codex", "copilot"] as const) {
      const dirName = runtimeFor(kind).descriptor.dirName.encode("/tmp/project")
      expect(runtimeForDirName(dirName).kind).toBe(kind)
    }
    expect(runtimeForDirName("-tmp-project").kind).toBe("claude")
    expect(runtimeForDirName(null).kind).toBe("claude")
  })

  it("reports a session active when any one runtime holds it, open or mid-turn", () => {
    expect(isSessionActive("sess-1")).toBe(false)

    copilot.isSessionActive.mockImplementation((id: string) => id === "sess-1")
    expect(isSessionActive("sess-1")).toBe(true)
    expect(isSessionActive("sess-2")).toBe(false)

    copilot.isSessionActive.mockReturnValue(false)
    copilot.isTurnActive.mockImplementation((id: string) => id === "sess-2")
    expect(isSessionActive("sess-2")).toBe(true)
  })
})

describe.each<AgentKind>(["claude", "codex", "copilot"])("%s runtime", (kind) => {
  const runtime = () => runtimeFor(kind)

  it("reports its own kind and descriptor", () => {
    expect(runtime().kind).toBe(kind)
    expect(runtime().descriptor.kind).toBe(kind)
  })

  it("reports neither live nor running for an id it has never seen", () => {
    expect(runtime().activity("unknown")).toEqual({ live: false, running: false })
    expect(runtime().hasSession("unknown")).toBe(false)
  })

  it("lists no active work when idle", () => {
    expect(runtime().listActive()).toEqual([])
  })

  it("has nothing pending for an unknown session", () => {
    expect(runtime().listPendingApprovals("unknown")).toEqual([])
    expect(runtime().listPendingQuestions("unknown")).toEqual([])
  })

  it("declines to interrupt or stop a session it does not hold", async () => {
    await expect(runtime().interrupt("unknown")).resolves.toBe(false)
    await expect(runtime().stop("unknown")).resolves.toBe(false)
  })

  it("reports nothing stopped and nothing failed from an idle stop-all", async () => {
    await expect(runtime().stopAll()).resolves.toEqual({ stopped: 0, failed: 0 })
  })

  it("answers an approval it never issued with false", async () => {
    await expect(runtime().respondToApproval("unknown", "req-1", "allow")).resolves.toBe(false)
  })

  it("shuts down without throwing", async () => {
    await expect(runtime().shutdown()).resolves.toBeUndefined()
  })
})

describe("reporting a new session's id", () => {
  it("tells a Claude caller the id before the SDK query is spawned", async () => {
    const onSessionId = vi.fn()
    vi.mocked(createSDKSession).mockReturnValueOnce({} as SDKSessionState)

    const started = await runtimeFor("claude").start({
      dirName: "-tmp-project",
      cwd: "/tmp/project",
      message: "hi",
      onSessionId,
    })

    expect(onSessionId.mock.calls).toEqual([[started.sessionId]])
    expect(onSessionId.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(createSDKSession).mock.invocationCallOrder[0])
  })

  it("tells a Copilot caller the id even when the session cannot be created", async () => {
    const onSessionId = vi.fn()
    copilot.createSession.mockRejectedValueOnce(new Error("rpc connection closed"))

    await expect(runtimeFor("copilot").start({
      dirName: runtimeFor("copilot").descriptor.dirName.encode("/tmp/project"),
      cwd: "/tmp/project",
      message: "hi",
      onSessionId,
    })).rejects.toMatchObject({ code: "SPAWN_FAILED" })

    expect(onSessionId.mock.calls).toEqual([["generated-uuid"]])
  })

  it.each<AgentKind>(["claude", "copilot"])("still starts a %s session when the caller's onSessionId throws", async (kind) => {
    vi.mocked(createSDKSession).mockReturnValueOnce({} as SDKSessionState)
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const started = await runtimeFor(kind).start({
        dirName: runtimeFor(kind).descriptor.dirName.encode("/tmp/project"),
        cwd: "/tmp/project",
        message: "hi",
        onSessionId: () => { throw new Error("owner store unavailable") },
      })
      expect(started.sessionId).toBe("generated-uuid")
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})

describe("a follow-up to a live Claude query", () => {
  /** A query the SDK still holds, marking itself running as it takes a message the way the real one does. */
  function liveQuery(running: boolean): void {
    const state = { running }
    sdk.sdkSessions.set("session-1", state)
    sdk.isSDKQueryLive.mockReturnValue(true)
    vi.mocked(sendSDKMessage).mockImplementationOnce(() => {
      state.running = true
      return state as unknown as SDKSessionState
    })
  }

  it("starts a turn when the query is idle between turns", async () => {
    liveQuery(false)

    await expect(runtimeFor("claude").send("session-1", { message: "next" }))
      .resolves.toEqual({ delivery: "started" })
    expect(resumeSDKSession).not.toHaveBeenCalled()
  })

  it("joins the turn the query is running", async () => {
    liveQuery(true)

    await expect(runtimeFor("claude").send("session-1", { message: "also" }))
      .resolves.toEqual({ delivery: "enqueued" })
  })
})

describe("agent asymmetries the registry must not flatten", () => {
  it("interrupts Codex turns but destroys Copilot sessions on stop-all", async () => {
    codex.listActiveTurns.mockReturnValue([
      { threadId: "thread-parent", turnId: "turn-parent" },
      { threadId: "thread-child", turnId: "turn-child" },
    ])
    copilot.getActiveSessionIds.mockReturnValue(["copilot-1"])

    await expect(runtimeFor("codex").stopAll()).resolves.toEqual({ stopped: 2, failed: 0 })
    await expect(runtimeFor("copilot").stopAll()).resolves.toEqual({ stopped: 1, failed: 0 })

    expect(codex.interruptTurn.mock.calls).toEqual([
      ["thread-parent", "turn-parent"],
      ["thread-child", "turn-child"],
    ])
    expect(copilot.destroySession.mock.calls).toEqual([["copilot-1"]])
    expect(copilot.deleteSession).not.toHaveBeenCalled()
  })

  it("counts each failed stop separately so kill-all can report them", async () => {
    codex.listActiveTurns.mockReturnValue([
      { threadId: "t1", turnId: "turn-1" },
      { threadId: "t2", turnId: "turn-2" },
    ])
    codex.interruptTurn
      .mockRejectedValueOnce(new Error("transport lost"))
      .mockResolvedValueOnce({})

    await expect(runtimeFor("codex").stopAll()).resolves.toEqual({ stopped: 1, failed: 1 })
  })

  it("stops a Copilot session over RPC without signalling any process", async () => {
    copilot.isSessionActive.mockReturnValue(true)
    copilot.isTurnActive.mockReturnValue(true)

    await expect(runtimeFor("copilot").stop("copilot-1")).resolves.toBe(true)

    expect(copilot.abort).toHaveBeenCalledWith("copilot-1")
    expect(copilot.destroySession).toHaveBeenCalledWith("copilot-1")
    expect(registry.terminateTrackedSession).not.toHaveBeenCalled()
  })

  it("holds a Copilot session whose only state is a plan waiting for review", () => {
    copilot.getPendingExitPlans.mockImplementation((sessionId?: string) => (
      sessionId === "opening-1" ? [{ sessionId, requestId: "plan-1" }] : []
    ))

    expect(runtimeForSession("opening-1")?.kind).toBe("copilot")
    expect(runtimeForSession("elsewhere")).toBeNull()
  })

  it("asks Copilot for the live usage of the sessions named, or of every open one", async () => {
    copilot.getActiveSessionIds.mockReturnValue(["copilot-1", "copilot-2", "copilot-3"])

    await runtimeFor("copilot").liveUsageRecords(new Map(), new Set(["copilot-2", "closed"]))
    expect(copilot.getSessionUsage.mock.calls).toEqual([["copilot-2"]])

    copilot.getSessionUsage.mockClear()
    await runtimeFor("copilot").liveUsageRecords(new Map())
    expect(copilot.getSessionUsage.mock.calls).toEqual([["copilot-1"], ["copilot-2"], ["copilot-3"]])
  })

  it("deletes a Copilot session through the CLI, never by unlinking its file", async () => {
    copilot.isSessionActive.mockReturnValue(true)

    await runtimeFor("copilot").deleteSession("copilot-1", "/tmp/copilot/copilot-1/events.jsonl")

    expect(copilot.destroySession).toHaveBeenCalledWith("copilot-1")
    expect(copilot.deleteSession).toHaveBeenCalledWith("copilot-1")
    expect(vi.mocked(unlink)).not.toHaveBeenCalled()
  })

  it.each<AgentKind>(["claude", "codex"])(
    "deletes a %s session by unlinking its transcript",
    async (fileOwner) => {
      await runtimeFor(fileOwner).deleteSession("session-1", "/tmp/session-1.jsonl")

      expect(registry.terminateTrackedSession).toHaveBeenCalledWith("session-1")
      expect(vi.mocked(unlink)).toHaveBeenCalledWith("/tmp/session-1.jsonl")
    },
  )

  it("refuses a concurrent send while a legacy Codex child owns the turn", async () => {
    registry.persistentSessions.set("thread-1", { dead: false, agentKind: "codex" })

    await expect(runtimeFor("codex").send("thread-1", { message: "hi" }))
      .resolves.toEqual({ delivery: "busy" })
  })

  it("has no question channel for Codex", async () => {
    expect(runtimeFor("codex").listPendingQuestions()).toEqual([])
    await expect(runtimeFor("codex").answerQuestion("t1", "q1", "yes")).resolves.toBeNull()
  })
})
