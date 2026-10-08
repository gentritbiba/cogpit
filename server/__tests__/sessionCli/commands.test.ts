// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const fakeHost = (id: string, name: string, remote: boolean) => ({
    id,
    name,
    remote,
    create: vi.fn(),
    send: vi.fn(),
    state: vi.fn(),
    wait: vi.fn(),
    result: vi.fn(),
    respond: vi.fn(),
    interrupt: vi.fn(),
    stop: vi.fn(),
    has: vi.fn(),
    projects: vi.fn(),
  })
  return {
    local: fakeHost("local", "this machine", false),
    remote: fakeHost("dev_1", "agentbox", true),
    waitAcrossHosts: vi.fn(),
    recordSessionOrigin: vi.fn(),
    sessionChildren: vi.fn(),
    sessionOrigin: vi.fn(),
    deviceJson: vi.fn(),
    sendWorkspace: vi.fn(),
    fetchWorkspaceBack: vi.fn(),
    discardWorkspace: vi.fn(),
    clearSessionHandoff: vi.fn(),
    ensureSessionApi: vi.fn(),
    accessLevelOf: vi.fn(),
  }
})

type FakeHost = typeof mocks.local
const hostOf = (sessionId: string): FakeHost => (sessionId.startsWith("r") ? mocks.remote : mocks.local)

vi.mock("../../edition", async (original) => ({
  ...await original<typeof import("../../edition")>(),
  accessLevelOf: mocks.accessLevelOf,
}))

vi.mock("../../sessionHosts", () => ({
  localHost: mocks.local,
  hostNamed: (name: string) => {
    if (name === "agentbox") return mocks.remote
    throw new Error(`No device named "${name}"`)
  },
  hostForSession: async (sessionId: string) => hostOf(sessionId),
  locateSessions: async (ids: string[]) => ids.map((sessionId) => ({ host: hostOf(sessionId), sessionId })),
  remoteHostsList: () => [mocks.remote],
  ensureSessionApi: mocks.ensureSessionApi,
  waitAcrossHosts: mocks.waitAcrossHosts,
}))
vi.mock("../../lib/sessionOrigins", () => ({
  recordSessionOrigin: mocks.recordSessionOrigin,
  sessionChildren: mocks.sessionChildren,
  sessionOrigin: mocks.sessionOrigin,
  clearSessionHandoff: mocks.clearSessionHandoff,
}))
vi.mock("../../hub/deviceRequest", () => ({ deviceJson: mocks.deviceJson }))
const boards = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock("../../lib/sessionBoards", () => ({
  sessionBoard: async (id: string) => boards.get(id) ?? null,
  setSessionBoard: async (id: string, content: Record<string, unknown>) => {
    const board = { sessionId: id, ...content, updatedAt: 1 }
    boards.set(id, board)
    return board
  },
  setSessionBoardProgress: async (id: string, progress: unknown) => {
    const board = { ...(boards.get(id) ?? { sessionId: id, sections: [] }), progress, updatedAt: 2 }
    boards.set(id, board)
    return board
  },
  clearSessionBoard: async (id: string) => boards.delete(id),
}))
vi.mock("../../sessionHosts/delegatedRequests", () => ({ watchDelegatedRequestsOf: vi.fn() }))
vi.mock("../../workspaceTransfer/handoff", () => ({
  sendWorkspace: mocks.sendWorkspace,
  fetchWorkspaceBack: mocks.fetchWorkspaceBack,
  discardWorkspace: mocks.discardWorkspace,
  handoffBriefing: () => "[Cogpit] Handed over from mac.",
}))

const handoff = { repoRoot: "/work/app", base: "b".repeat(40), workspaceId: "app-1234567890/fix", branch: "cogpit/agentbox/fix" }

import { EXIT, runSessionCli, type CliInvocation } from "../../sessionCli/commands"
import { PERSONAL_EDITION } from "../../edition"
import { orchestrationStore } from "../../orchestration/storage"

function run(argv: string[], overrides: Partial<CliInvocation> = {}) {
  return runSessionCli({
    argv,
    cwd: "/work/app",
    invocationId: "invocation-1",
    scope: "local",
    admin: true,
    visible: PERSONAL_EDITION.access.visibilityFor({} as never),
    callerSessionId: "parent-1",
    ...overrides,
  })
}

const out = (output: { stdout: string }) => JSON.parse(output.stdout)

function state(sessionId: string, outcome: string, extra: Record<string, unknown> = {}) {
  return { sessionId, outcome, live: true, running: outcome === "running", waiting: [], ...extra }
}

const permission = { kind: "permission", requestId: "perm-1", toolName: "Bash", summary: "ls", availableDecisions: ["allow", "deny"] }

function pending(host: FakeHost, waiting: unknown[]) {
  host.state.mockImplementation(async (id: string) => state(id, "needs_input", { waiting }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.accessLevelOf.mockResolvedValue("own")
  mocks.sessionOrigin.mockResolvedValue(null)
  for (const host of [mocks.local, mocks.remote]) {
    host.create.mockResolvedValue({ sessionId: host.remote ? "r-child" : "child-1", dirName: "-work-app" })
    host.send.mockResolvedValue({ delivery: "enqueued" })
    host.result.mockResolvedValue({
      turn: { reply: "All done" },
      filesChanged: [{ path: "/work/app/a.ts", type: "edit", additions: 1, deletions: 0 }],
    })
    host.respond.mockImplementation(async (_s: string, requestId: string) => ({ kind: "permission", requestId }))
    host.stop.mockResolvedValue(true)
  }
})

describe("parsed target authorization", () => {
  it.each([
    ["result", "--text", "private-session"],
    ["approve", "--request", "permission-1", "private-session"],
    ["send", "--steer", "private-session", "hello"],
    ["answer", "--json", '{"Choice?":"Yes"}', "private-session"],
  ])("authorizes flags-first %s invocations before contacting a host", async (...argv) => {
    mocks.accessLevelOf.mockResolvedValue(null)
    const output = await run(argv, { req: {} as never })
    expect(output.stderr).toContain("Session access denied")
    expect(mocks.accessLevelOf).toHaveBeenCalledWith(expect.anything(), "private-session")
    expect(mocks.local.result).not.toHaveBeenCalled()
    expect(mocks.local.respond).not.toHaveBeenCalled()
    expect(mocks.local.send).not.toHaveBeenCalled()
  })
})

describe("usage", () => {
  it("prints help, and fails on an unknown command or option", async () => {
    expect(await run(["help"])).toMatchObject({ exitCode: EXIT.ok, stdout: expect.stringContaining("Usage:") })
    expect(await run([])).toMatchObject({ exitCode: EXIT.error })
    expect(await run(["frobnicate"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("Unknown command") })
    expect(await run(["status", "s", "--bogus"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("--bogus") })
  })
})

describe("new", () => {
  it("acknowledges the result returned by a blocking invocation, but keeps a timed-out child asynchronous", async () => {
    mocks.waitAcrossHosts.mockResolvedValueOnce({ timedOut: false, sessions: [state("child-1", "completed")] })
    expect((await run(["new", "work", "--wait"])).exitCode).toBe(EXIT.ok)
    expect(orchestrationStore().tasks("local", "parent-1")[0]).toMatchObject({ state: "completed", deliveryDisposition: "async", acknowledgedAt: expect.any(Number) })
    mocks.waitAcrossHosts.mockResolvedValueOnce({ timedOut: true, sessions: [state("child-1", "running")] })
    expect((await run(["new", "work", "--wait", "--timeout", "0"], { invocationId: "timed-out" })).exitCode).toBe(EXIT.timedOut)
    expect(orchestrationStore().tasks("local", "parent-1").find((task) => task.sourceId === "timed-out")).toMatchObject({ state: "running", deliveryDisposition: "async" })
  })
  it("starts a session in the caller's directory with bypass permissions and records the parent", async () => {
    const output = await run(["new", "fix", "the", "tests", "--model", "haiku"])
    expect(mocks.local.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/work/app",
      message: "fix the tests",
      model: "haiku",
      mode: "bypassPermissions",
      requestId: "invocation-1",
      scope: "local",
    }))
    expect(mocks.recordSessionOrigin).toHaveBeenCalledWith("child-1", { parentSessionId: "parent-1" })
    expect(out(output)).toEqual({ sessionId: "child-1", dirName: "-work-app", next: "cogpit-session wait child-1" })
  })

  it("records the name a session was started with, so the crew can call it that", async () => {
    await run(["new", "rebase onto main", "--name", "w3-rooftop"])
    expect(mocks.local.create).toHaveBeenCalledWith(expect.objectContaining({ name: "w3-rooftop" }))
    expect(mocks.recordSessionOrigin).toHaveBeenCalledWith("child-1", { parentSessionId: "parent-1", name: "w3-rooftop" })
  })

  it("resolves a relative --cwd, honors --mode and rejects an unknown agent", async () => {
    await run(["new", "hi", "--cwd", "../lib", "--mode=acceptEdits"])
    expect(mocks.local.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work/lib", mode: "acceptEdits" }))
    expect(await run(["new", "hi", "--agent", "nope"])).toMatchObject({ exitCode: EXIT.error })
    expect(await run(["new"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("needs a message") })
  })

  it("starts on a device in a folder already there", async () => {
    const output = await run(["new", "hi", "--device", "agentbox", "--cwd", "/home/dev/app"])
    expect(mocks.remote.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/home/dev/app", message: "hi" }))
    expect(mocks.sendWorkspace).not.toHaveBeenCalled()
    expect(mocks.recordSessionOrigin).toHaveBeenCalledWith("r-child", {
      parentSessionId: "parent-1",
      deviceId: "dev_1",
      asksUser: true,
    })
    expect(out(output)).toMatchObject({ sessionId: "r-child", device: "agentbox" })

    expect(await run(["new", "hi", "--device", "agentbox", "--cwd", "rel/path"])).toMatchObject({
      exitCode: EXIT.error,
      stderr: expect.stringContaining("projects --device agentbox"),
    })
    expect(await run(["new", "hi", "--device", "nowhere", "--cwd", "/x"])).toMatchObject({
      exitCode: EXIT.error,
      stderr: expect.stringContaining("No device named"),
    })
  })

  it("hands the caller's repository over, once per invocation, and says where it comes back", async () => {
    mocks.sendWorkspace.mockResolvedValue({
      handoff,
      remoteCwd: "/home/dev/.cogpit/workspaces/app-1234567890/fix",
      remoteBranch: "cogpit/fix",
    })
    const output = await run(["new", "fix", "the", "parser", "--device", "agentbox"], { invocationId: "handoff-1" })
    expect(mocks.ensureSessionApi).toHaveBeenCalledWith("dev_1")
    expect(mocks.sendWorkspace).toHaveBeenCalledWith("dev_1", "agentbox", "/work/app", "fix the parser", "local:handoff-1")
    expect(mocks.remote.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/home/dev/.cogpit/workspaces/app-1234567890/fix",
      message: "[Cogpit] Handed over from mac.\n\nfix the parser",
    }))
    expect(mocks.recordSessionOrigin).toHaveBeenCalledWith("r-child", expect.objectContaining({ handoff }))
    expect(out(output).workspace).toEqual({
      cwd: "/home/dev/.cogpit/workspaces/app-1234567890/fix",
      branch: "cogpit/fix",
      returnsTo: "cogpit/agentbox/fix",
    })

    await run(["new", "fix", "the", "parser", "--device", "agentbox"], { invocationId: "handoff-1" })
    expect(mocks.sendWorkspace).toHaveBeenCalledTimes(1)

    expect(await run(["new", "x", "--device", "agentbox", "--worktree", "w"], { invocationId: "handoff-2" })).toMatchObject({
      exitCode: EXIT.error,
      stderr: expect.stringContaining("--worktree cannot be combined"),
    })
  })

  it("sends again after a failed send instead of replaying the failure", async () => {
    mocks.sendWorkspace.mockRejectedValueOnce(new Error("device went away")).mockResolvedValue({
      handoff,
      remoteCwd: "/home/dev/w",
      remoteBranch: "cogpit/fix",
    })
    expect(await run(["new", "hi", "--device", "agentbox"], { invocationId: "handoff-3" })).toMatchObject({ exitCode: EXIT.error })
    expect(await run(["new", "hi", "--device", "agentbox"], { invocationId: "handoff-3" })).toMatchObject({ exitCode: EXIT.ok })
    expect(mocks.sendWorkspace).toHaveBeenCalledTimes(2)
  })

  it("brings a handed-over session's work back when it finishes", async () => {
    mocks.sessionOrigin.mockResolvedValue({ deviceId: "dev_1", handoff, createdAt: 1 })
    mocks.waitAcrossHosts.mockResolvedValue({ timedOut: false, sessions: [state("r1", "completed")] })
    mocks.fetchWorkspaceBack.mockResolvedValue({
      branch: handoff.branch,
      branchUpdated: true,
      ref: "refs/cogpit/returns/agentbox/fix",
      base: handoff.base,
      tip: "c".repeat(40),
      files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
    })
    const report = out(await run(["wait", "r1"]))
    expect(mocks.fetchWorkspaceBack).toHaveBeenCalledWith("dev_1", handoff)
    expect(report.returned).toMatchObject({ branch: "cogpit/agentbox/fix", files: [{ path: "src/a.ts" }] })
    expect(report.apply[1]).toBe(`Apply to the working tree: git -C /work/app diff ${"b".repeat(12)} cogpit/agentbox/fix | git -C /work/app apply`)

    mocks.fetchWorkspaceBack.mockResolvedValueOnce({
      branch: handoff.branch,
      branchUpdated: false,
      ref: "refs/cogpit/returns/agentbox/fix",
      base: handoff.base,
      tip: "c".repeat(40),
      files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
    })
    const kept = out(await run(["fetch", "r1"]))
    expect(kept.returned.note).toContain("left alone")
    expect(kept.apply[0]).toContain("refs/cogpit/returns/agentbox/fix")

    mocks.fetchWorkspaceBack.mockRejectedValue(new Error("device gone"))
    expect(out(await run(["fetch", "r1"]))).toMatchObject({ returnError: expect.stringContaining("device gone") })
    mocks.sessionOrigin.mockResolvedValue(null)
    expect(await run(["fetch", "r1"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("not handed") })
  })

  it("waits for the turn and reports the reply with --wait", async () => {
    mocks.waitAcrossHosts.mockResolvedValue({ timedOut: false, sessions: [state("child-1", "completed")] })
    const output = await run(["new", "hi", "--wait", "--timeout", "5"])
    expect(mocks.waitAcrossHosts).toHaveBeenCalledWith(
      [{ host: mocks.local, sessionId: "child-1" }],
      expect.objectContaining({ mode: "all", timeoutMs: 5000 }),
    )
    expect(output.exitCode).toBe(EXIT.ok)
    expect(out(output)).toMatchObject({ outcome: "completed", reply: "All done", filesChanged: [{ path: "/work/app/a.ts" }] })
  })
})

describe("discard", () => {
  beforeEach(() => {
    mocks.remote.state.mockResolvedValue(state("r1", "completed"))
  })

  it("stops the session, brings its work back, then removes the device's worktree", async () => {
    mocks.sessionOrigin.mockResolvedValue({ deviceId: "dev_1", handoff, createdAt: 1 })
    mocks.fetchWorkspaceBack.mockResolvedValue({
      branch: handoff.branch, branchUpdated: true, ref: "r", base: handoff.base, tip: "c".repeat(40), files: [],
    })
    expect(out(await run(["discard", "r1"]))).toMatchObject({ discarded: true, returned: { branch: handoff.branch } })
    expect(mocks.remote.stop).toHaveBeenCalledWith("r1")
    expect(mocks.discardWorkspace).toHaveBeenCalledWith("dev_1", handoff)
    expect(mocks.clearSessionHandoff).toHaveBeenCalledWith("r1")

    mocks.discardWorkspace.mockClear()
    mocks.fetchWorkspaceBack.mockRejectedValue(new Error("device gone"))
    expect(await run(["discard", "r1"])).toMatchObject({ exitCode: EXIT.error })
    expect(mocks.discardWorkspace).not.toHaveBeenCalled()
  })

  it("leaves the worktree alone when the session could not be stopped", async () => {
    mocks.sessionOrigin.mockResolvedValue({ deviceId: "dev_1", handoff, createdAt: 1 })
    mocks.remote.stop.mockRejectedValueOnce(new Error("device went away"))
    expect(await run(["discard", "r1"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("device went away") })

    mocks.remote.state.mockResolvedValueOnce(state("r1", "running"))
    expect(await run(["discard", "r1"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("still running") })

    // Blocked on a prompt its process is still alive to act on.
    mocks.remote.stop.mockResolvedValueOnce(false)
    mocks.remote.state.mockResolvedValueOnce(state("r1", "needs_input", { running: true }))
    expect(await run(["discard", "r1"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("still running") })

    mocks.remote.state.mockResolvedValueOnce(state("r1", "unreachable", { error: "device offline" }))
    expect(await run(["discard", "r1"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("Could not confirm") })

    expect(mocks.fetchWorkspaceBack).not.toHaveBeenCalled()
    expect(mocks.discardWorkspace).not.toHaveBeenCalled()
  })

  it("refuses workspace transfers from a caller who is not an admin", async () => {
    mocks.sessionOrigin.mockResolvedValue({ deviceId: "dev_1", handoff, createdAt: 1 })
    for (const argv of [["new", "hi", "--device", "agentbox"], ["fetch", "r1"], ["discard", "r1"]]) {
      expect(await run(argv, { admin: false, invocationId: `member-${argv[0]}` })).toMatchObject({
        exitCode: EXIT.error,
        stderr: expect.stringContaining("Only an admin"),
      })
    }
    expect(mocks.sendWorkspace).not.toHaveBeenCalled()
    expect(mocks.fetchWorkspaceBack).not.toHaveBeenCalled()
    expect(mocks.discardWorkspace).not.toHaveBeenCalled()

    mocks.waitAcrossHosts.mockResolvedValue({ timedOut: false, sessions: [state("r1", "completed")] })
    expect(out(await run(["wait", "r1"], { admin: false })).returned).toBeUndefined()
    expect(mocks.fetchWorkspaceBack).not.toHaveBeenCalled()
  })
})

describe("questions for the user", () => {
  it("routes a device session's questions to the user unless told otherwise, and a local one's only when asked", async () => {
    await run(["new", "hi", "--device", "agentbox", "--cwd", "/x", "--questions", "agent"])
    expect(mocks.recordSessionOrigin).toHaveBeenLastCalledWith("r-child", { parentSessionId: "parent-1", deviceId: "dev_1" })
    await run(["new", "hi", "--questions", "user"])
    expect(mocks.recordSessionOrigin).toHaveBeenLastCalledWith("child-1", { parentSessionId: "parent-1", asksUser: true })
    expect(await run(["new", "hi", "--questions", "boss"])).toMatchObject({ exitCode: EXIT.error })
  })

  it("keeps waiting while the user has the question, and says so when time runs out", async () => {
    mocks.sessionOrigin.mockResolvedValue({ asksUser: true, createdAt: 1 })
    const asking = state("r1", "needs_input", { waiting: [permission] })
    mocks.waitAcrossHosts
      .mockResolvedValueOnce({ timedOut: false, sessions: [asking] })
      .mockResolvedValueOnce({ timedOut: false, sessions: [state("r1", "completed")] })
    vi.useFakeTimers()
    try {
      const pendingRun = run(["wait", "r1", "--timeout", "60"])
      await vi.advanceTimersByTimeAsync(2000)
      const output = await pendingRun
      expect(mocks.waitAcrossHosts).toHaveBeenCalledTimes(2)
      expect(output.exitCode).toBe(EXIT.ok)
      expect(out(output)).toMatchObject({ outcome: "completed", reply: "All done" })

      mocks.waitAcrossHosts.mockReset().mockResolvedValue({ timedOut: false, sessions: [asking] })
      const timingOut = run(["wait", "r1", "--timeout", "3"])
      await vi.advanceTimersByTimeAsync(4000)
      const late = await timingOut
      expect(late.exitCode).toBe(EXIT.timedOut)
      expect(out(late)).toMatchObject({ outcome: "needs_input", askedUser: true })
      expect(out(late).next[0]).toContain("The user was asked in Cogpit")
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("send", () => {
  it("delivers through the session's host, interrupting first when asked", async () => {
    const output = await run(["send", "r1", "and", "now", "docs", "--interrupt"])
    expect(mocks.remote.send).toHaveBeenCalledWith("r1", "and now docs", { interrupt: true, intent: "restart", commandId: "invocation-1", req: undefined })
    expect(out(output)).toMatchObject({ sessionId: "r1", device: "agentbox", delivery: "enqueued" })
  })
})

describe("wait", () => {
  it("waits across machines and reports needs_input with the commands that answer it", async () => {
    mocks.waitAcrossHosts.mockResolvedValue({
      timedOut: false,
      sessions: [state("s1", "needs_input", { waiting: [permission] }), state("r2", "running")],
    })
    const output = await run(["wait", "s1", "r2", "--any"])
    expect(mocks.waitAcrossHosts).toHaveBeenCalledWith(
      [{ host: mocks.local, sessionId: "s1" }, { host: mocks.remote, sessionId: "r2" }],
      expect.objectContaining({ mode: "any" }),
    )
    expect(output.exitCode).toBe(EXIT.needsInput)
    const [first, second] = out(output).sessions
    expect(first.waiting).toEqual([permission])
    expect(first.next[0]).toContain("cogpit-session approve s1 --request perm-1")
    expect(second).toMatchObject({ sessionId: "r2", device: "agentbox", outcome: "running" })
  })

  it("exits 3 with a hint to keep waiting on a timeout, unreachable devices included", async () => {
    mocks.waitAcrossHosts.mockResolvedValue({ timedOut: true, sessions: [state("r1", "unreachable", { error: "down" })] })
    const output = await run(["wait", "r1"])
    expect(output.exitCode).toBe(EXIT.timedOut)
    expect(out(output)).toMatchObject({ outcome: "unreachable", error: "down", next: "cogpit-session wait r1" })
  })

  it("reads a finished remote session's reply from its device", async () => {
    mocks.waitAcrossHosts.mockResolvedValue({ timedOut: false, sessions: [state("r1", "completed")] })
    expect(out(await run(["wait", "r1"]))).toMatchObject({ device: "agentbox", reply: "All done" })
    expect(mocks.remote.result).toHaveBeenCalledWith("r1")
  })
})

describe("answering", () => {
  it("approves the only pending request, and asks which when there are several", async () => {
    pending(mocks.remote, [permission])
    await run(["approve", "r1", "--always"])
    expect(mocks.remote.respond).toHaveBeenCalledWith("r1", "perm-1", { decision: "allow_always" }, { commandId: "invocation-1", req: undefined })

    pending(mocks.local, [permission, { ...permission, requestId: "perm-2" }])
    expect(await run(["deny", "s1"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("perm-1, perm-2") })
    await run(["deny", "s1", "--request", "perm-2"])
    expect(mocks.local.respond).toHaveBeenLastCalledWith("s1", "perm-2", { decision: "deny" }, { commandId: "invocation-1", req: undefined })
  })

  it("answers a plan with approval and feedback", async () => {
    pending(mocks.local, [{ kind: "plan", requestId: "plan-1", summary: "", actions: [], recommendedAction: "" }])
    await run(["deny", "s1", "--feedback", "smaller steps"])
    expect(mocks.local.respond).toHaveBeenCalledWith("s1", "plan-1", { approved: false, feedback: "smaller steps" }, { commandId: "invocation-1", req: undefined })
  })

  it("sends one answer as text, several as a list, and --json as a map", async () => {
    pending(mocks.local, [{ kind: "question", requestId: "q-1", questions: [] }])
    await run(["answer", "s1", "Blue"])
    expect(mocks.local.respond).toHaveBeenLastCalledWith("s1", "q-1", { answers: "Blue" }, { commandId: "invocation-1", req: undefined })
    await run(["answer", "s1", "Blue", "Large"])
    expect(mocks.local.respond).toHaveBeenLastCalledWith("s1", "q-1", { answers: ["Blue", "Large"] }, { commandId: "invocation-1", req: undefined })
    await run(["answer", "s1", "--json", '{"Color?":"Blue"}'])
    expect(mocks.local.respond).toHaveBeenLastCalledWith("s1", "q-1", { answers: { "Color?": "Blue" } }, { commandId: "invocation-1", req: undefined })
    expect(await run(["answer", "s1", "--json", "[1]"])).toMatchObject({ exitCode: EXIT.error })
  })
})

describe("children and stop", () => {
  it("lists and stops the sessions the caller started, on every machine", async () => {
    mocks.sessionChildren.mockResolvedValue(["c1", "r2"])
    mocks.local.state.mockImplementation(async (id: string) => state(id, "completed"))
    mocks.remote.state.mockImplementation(async (id: string) => state(id, "running"))
    expect(out(await run(["children"]))).toEqual({
      sessionId: "parent-1",
      children: [
        { sessionId: "c1", outcome: "completed" },
        { sessionId: "r2", device: "agentbox", outcome: "running" },
      ],
    })

    mocks.remote.stop.mockRejectedValue(new Error("unreachable"))
    expect(out(await run(["stop", "--children"])).sessions).toEqual([
      { sessionId: "c1", stopped: true },
      { sessionId: "r2", device: "agentbox", stopped: false },
    ])
    expect(await run(["stop", "--children"], { callerSessionId: undefined })).toMatchObject({ exitCode: EXIT.error })
  })
})

describe("result", () => {
  it("prints only the reply with --text and fails for an unknown session", async () => {
    expect(await run(["result", "s1", "--text"])).toEqual({ exitCode: EXIT.ok, stdout: "All done\n", stderr: "" })
    mocks.local.result.mockResolvedValue(null)
    expect(await run(["result", "s1"])).toMatchObject({ exitCode: EXIT.error })
  })
})

describe("devices and projects", () => {
  it("lists devices with whether they can run sessions", async () => {
    mocks.deviceJson.mockResolvedValueOnce({ version: "2.7.0", sessionApi: 1 })
    expect(out(await run(["devices"]))).toEqual({
      devices: [{ name: "agentbox", id: "dev_1", online: true, version: "2.7.0" }],
    })
    mocks.deviceJson.mockRejectedValueOnce(new Error("Could not reach device"))
    expect(out(await run(["devices"])).devices[0]).toMatchObject({ online: false, error: "Could not reach device" })
  })

  it("lists a device's project folders", async () => {
    mocks.remote.projects.mockResolvedValue([
      { dirName: "-home-dev-app", path: "/home/dev/app", shortName: "app", lastModified: "2026-09-25" },
    ])
    expect(out(await run(["projects", "--device", "agentbox"]))).toEqual({
      device: "agentbox",
      projects: [{ path: "/home/dev/app", name: "app", lastModified: "2026-09-25" }],
    })
  })
})

describe("board", () => {
  beforeEach(() => boards.clear())

  it("sets the caller's board from YAML, moves its progress and reads it back", async () => {
    const set = await run(["board", "set", "title: Wave 3\nprogress: 35/99\nsections:\n  - { title: Needs you, tone: warning, items: [sentry-cli login] }"])
    expect(set.exitCode).toBe(EXIT.ok)
    expect(out(set)).toMatchObject({ sessionId: "parent-1", title: "Wave 3", progress: { done: 35, total: 99 } })

    expect(out(await run(["board", "progress", "36/99"]))).toMatchObject({ title: "Wave 3", progress: { done: 36, total: 99 } })
    expect(out(await run(["board", "get"]))).toMatchObject({ sections: [{ title: "Needs you", tone: "warning", items: ["sentry-cli login"] }] })
    expect(out(await run(["board", "get", "someone-else"]))).toEqual({ sessionId: "someone-else", board: null })
    expect(out(await run(["board", "clear"]))).toEqual({ sessionId: "parent-1", cleared: true })
  })

  it("explains what it needs", async () => {
    expect(await run(["board", "set", "title: [unclosed"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("could not read that") })
    expect(await run(["board", "set", "nothing: here"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("needs a title, progress or sections") })
    expect(await run(["board", "progress", "35 of 99"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("DONE/TOTAL") })
    expect(await run(["board", "set", "title: x"], { callerSessionId: undefined })).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("COGPIT_SESSION_ID") })
    expect(await run(["board"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("set, progress, get or clear") })
  })
})
