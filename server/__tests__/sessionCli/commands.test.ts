// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  sendToSession: vi.fn(),
  readSessionState: vi.fn(),
  waitForSessions: vi.fn(),
  recordTurnError: vi.fn(),
  clearTurnError: vi.fn(),
  readSessionResult: vi.fn(),
  sessionChildren: vi.fn(),
  listPendingInput: vi.fn(),
  respondToPendingInput: vi.fn(),
  interrupt: vi.fn(),
  stop: vi.fn(),
}))

vi.mock("../../routes/session-new/sessionSpawner", () => ({ createSession: mocks.createSession }))
vi.mock("../../routes/session-send", () => ({ sendToSession: mocks.sendToSession }))
vi.mock("../../lib/sessionWait", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  readSessionState: mocks.readSessionState,
  waitForSessions: mocks.waitForSessions,
  recordTurnError: mocks.recordTurnError,
  clearTurnError: mocks.clearTurnError,
}))
vi.mock("../../lib/sessionResult", () => ({ readSessionResult: mocks.readSessionResult }))
vi.mock("../../lib/sessionLineage", () => ({ sessionChildren: mocks.sessionChildren }))
vi.mock("../../agents/pendingInput", () => ({
  listPendingInput: mocks.listPendingInput,
  respondToPendingInput: mocks.respondToPendingInput,
}))
vi.mock("../../agents/runtimes", () => ({
  resolveSessionAgent: async () => ({ kind: "k", filePath: null }),
  runtimeFor: () => ({ interrupt: mocks.interrupt, stop: mocks.stop }),
}))

import { EXIT, runSessionCli, type CliInvocation } from "../../sessionCli/commands"

function run(argv: string[], overrides: Partial<CliInvocation> = {}) {
  return runSessionCli({
    argv,
    cwd: "/work/app",
    invocationId: "invocation-1",
    scope: "local",
    callerSessionId: "parent-1",
    ...overrides,
  })
}

const out = (output: { stdout: string }) => JSON.parse(output.stdout)

function state(sessionId: string, outcome: string, extra: Record<string, unknown> = {}) {
  return { sessionId, outcome, live: true, running: outcome === "running", waiting: [], ...extra }
}

const permission = { kind: "permission", requestId: "perm-1", toolName: "Bash", summary: "ls", availableDecisions: ["allow", "deny"] }

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.createSession.mockResolvedValue({ sessionId: "child-1", dirName: "-work-app", fileName: "child-1.jsonl" })
  mocks.sendToSession.mockResolvedValue({ outcome: { delivery: "enqueued" } })
  mocks.readSessionResult.mockResolvedValue({
    turn: { reply: "All done" },
    filesChanged: [{ path: "/work/app/a.ts", type: "edit", additions: 1, deletions: 0 }],
  })
  mocks.respondToPendingInput.mockImplementation(async (_s, requestId) => ({ kind: "permission", requestId }))
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
  it("starts a session in the caller's directory with bypass permissions and a parent", async () => {
    const output = await run(["new", "fix", "the", "tests", "--model", "haiku"])
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/work/app",
      message: "fix the tests",
      model: "haiku",
      permissions: { mode: "bypassPermissions" },
      parentSessionId: "parent-1",
      retry: { requestId: "invocation-1", scope: "local" },
    }))
    expect(out(output)).toEqual({ sessionId: "child-1", dirName: "-work-app", next: "cogpit-session wait child-1" })
  })

  it("resolves a relative --cwd, honors --mode and rejects an unknown agent", async () => {
    await run(["new", "hi", "--cwd", "../lib", "--mode=acceptEdits"])
    expect(mocks.createSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/work/lib",
      permissions: { mode: "acceptEdits" },
    }))
    expect(await run(["new", "hi", "--agent", "nope"])).toMatchObject({ exitCode: EXIT.error })
    expect(await run(["new"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("needs a message") })
  })

  it("waits for the turn and reports the reply with --wait", async () => {
    mocks.waitForSessions.mockResolvedValue({ timedOut: false, sessions: [state("child-1", "completed")] })
    const output = await run(["new", "hi", "--wait", "--timeout", "5"])
    expect(mocks.waitForSessions).toHaveBeenCalledWith(["child-1"], expect.objectContaining({ mode: "all", timeoutMs: 5000 }))
    expect(output.exitCode).toBe(EXIT.ok)
    expect(out(output)).toMatchObject({ outcome: "completed", reply: "All done", filesChanged: [{ path: "/work/app/a.ts" }] })
  })
})

describe("send", () => {
  it("interrupts first when asked and keeps a resume failure for wait", async () => {
    let settle: (value: { isError: boolean; message?: string }) => void = () => {}
    mocks.sendToSession.mockResolvedValue({
      outcome: { delivery: "started", completion: new Promise((resolve) => { settle = resolve }) },
    })
    const output = await run(["send", "s1", "and", "now", "docs", "--interrupt"])
    expect(mocks.interrupt).toHaveBeenCalledWith("s1")
    expect(mocks.clearTurnError).toHaveBeenCalledWith("s1")
    expect(mocks.sendToSession).toHaveBeenCalledWith("s1", { message: "and now docs" })
    expect(out(output)).toMatchObject({ sessionId: "s1", delivery: "started" })

    settle({ isError: true, message: "resume failed" })
    await vi.waitFor(() => expect(mocks.recordTurnError).toHaveBeenCalledWith("s1", "resume failed"))
  })
})

describe("wait", () => {
  it("reports needs_input with the commands that answer it", async () => {
    mocks.waitForSessions.mockResolvedValue({
      timedOut: false,
      sessions: [state("s1", "needs_input", { waiting: [permission] }), state("s2", "running")],
    })
    const output = await run(["wait", "s1", "s2", "--any"])
    expect(output.exitCode).toBe(EXIT.needsInput)
    const [first] = out(output).sessions
    expect(first.waiting).toEqual([permission])
    expect(first.next[0]).toContain("cogpit-session approve s1 --request perm-1")
  })

  it("exits 3 with a hint to keep waiting on a timeout", async () => {
    mocks.waitForSessions.mockResolvedValue({ timedOut: true, sessions: [state("s1", "running")] })
    const output = await run(["wait", "s1"])
    expect(output.exitCode).toBe(EXIT.timedOut)
    expect(out(output)).toMatchObject({ outcome: "running", next: "cogpit-session wait s1" })
  })
})

describe("answering", () => {
  it("approves the only pending request, and asks which when there are several", async () => {
    mocks.listPendingInput.mockReturnValue([permission])
    await run(["approve", "s1", "--always"])
    expect(mocks.respondToPendingInput).toHaveBeenCalledWith("s1", "perm-1", { decision: "allow_always" })

    mocks.listPendingInput.mockReturnValue([permission, { ...permission, requestId: "perm-2" }])
    expect(await run(["deny", "s1"])).toMatchObject({ exitCode: EXIT.error, stderr: expect.stringContaining("perm-1, perm-2") })
    await run(["deny", "s1", "--request", "perm-2"])
    expect(mocks.respondToPendingInput).toHaveBeenLastCalledWith("s1", "perm-2", { decision: "deny" })
  })

  it("answers a plan with approval and feedback", async () => {
    mocks.listPendingInput.mockReturnValue([{ kind: "plan", requestId: "plan-1", summary: "", actions: [], recommendedAction: "" }])
    await run(["deny", "s1", "--feedback", "smaller steps"])
    expect(mocks.respondToPendingInput).toHaveBeenCalledWith("s1", "plan-1", { approved: false, feedback: "smaller steps" })
  })

  it("sends one answer as text, several as a list, and --json as a map", async () => {
    mocks.listPendingInput.mockReturnValue([{ kind: "question", requestId: "q-1", questions: [] }])
    await run(["answer", "s1", "Blue"])
    expect(mocks.respondToPendingInput).toHaveBeenLastCalledWith("s1", "q-1", { answers: "Blue" })
    await run(["answer", "s1", "Blue", "Large"])
    expect(mocks.respondToPendingInput).toHaveBeenLastCalledWith("s1", "q-1", { answers: ["Blue", "Large"] })
    await run(["answer", "s1", "--json", '{"Color?":"Blue"}'])
    expect(mocks.respondToPendingInput).toHaveBeenLastCalledWith("s1", "q-1", { answers: { "Color?": "Blue" } })
    expect(await run(["answer", "s1", "--json", "[1]"])).toMatchObject({ exitCode: EXIT.error })
  })
})

describe("children and stop", () => {
  it("lists and stops the sessions the caller started", async () => {
    mocks.sessionChildren.mockResolvedValue(["c1", "c2"])
    mocks.readSessionState.mockImplementation(async (id: string) => state(id, id === "c1" ? "completed" : "running"))
    expect(out(await run(["children"]))).toEqual({
      sessionId: "parent-1",
      children: [{ sessionId: "c1", outcome: "completed" }, { sessionId: "c2", outcome: "running" }],
    })

    mocks.stop.mockResolvedValue(true)
    expect(out(await run(["stop", "--children"])).sessions).toEqual([
      { sessionId: "c1", stopped: true },
      { sessionId: "c2", stopped: true },
    ])
    expect(await run(["stop", "--children"], { callerSessionId: undefined })).toMatchObject({ exitCode: EXIT.error })
  })
})

describe("result", () => {
  it("prints only the reply with --text and fails for an unknown session", async () => {
    expect(await run(["result", "s1", "--text"])).toEqual({ exitCode: EXIT.ok, stdout: "All done\n", stderr: "" })
    mocks.readSessionResult.mockResolvedValue(null)
    expect(await run(["result", "s1"])).toMatchObject({ exitCode: EXIT.error })
  })
})
