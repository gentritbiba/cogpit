// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  waitForSessions: vi.fn(),
  readSessionState: vi.fn(),
  readSessionResult: vi.fn(),
  respondToPendingInput: vi.fn(),
  sessionChildren: vi.fn(),
  runSessionCli: vi.fn(),
}))

vi.mock("../../lib/sessionWait", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  waitForSessions: mocks.waitForSessions,
  readSessionState: mocks.readSessionState,
}))
vi.mock("../../lib/sessionResult", () => ({ readSessionResult: mocks.readSessionResult }))
vi.mock("../../agents/pendingInput", () => ({ respondToPendingInput: mocks.respondToPendingInput }))
vi.mock("../../lib/sessionLineage", () => ({ sessionChildren: mocks.sessionChildren }))
vi.mock("../../sessionCli/commands", () => ({ runSessionCli: mocks.runSessionCli }))

import { AgentRuntimeError } from "../../agents/runtimeTypes"
import { pendingInputResponseFrom, registerSessionOrchestrationRoutes } from "../../routes/session-orchestration"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

async function call(path: string, method: string, url: string, body?: unknown) {
  const handler = getRouteHandler(collectRoutes(registerSessionOrchestrationRoutes), path)
  const { req, res, next, sendBody } = createMockReqRes(method, url, body === undefined ? {} : { body: JSON.stringify(body) })
  Object.assign(res, { on: vi.fn() })
  const done = handler(req, res, next)
  sendBody()
  await done
  await vi.waitFor(() => expect(res.end.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0))
  return { status: res._getStatus(), body: JSON.parse(res._getData() || "null"), next }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
})

describe("/api/session-wait", () => {
  it("waits on one session from the path with the requested timeout", async () => {
    mocks.waitForSessions.mockResolvedValue({ timedOut: false, sessions: [{ sessionId: "s1", outcome: "completed" }] })
    const { status, body } = await call("/api/session-wait", "GET", "/s1?timeout=5")
    expect(status).toBe(200)
    expect(body).toEqual({ timedOut: false, sessionId: "s1", outcome: "completed" })
    expect(mocks.waitForSessions).toHaveBeenCalledWith(["s1"], expect.objectContaining({ mode: "all", timeoutMs: 5000 }))
  })

  it("waits on several sessions, deduplicated, in any mode", async () => {
    mocks.waitForSessions.mockResolvedValue({ timedOut: true, sessions: [] })
    const { body } = await call("/api/session-wait", "POST", "/", { sessionIds: ["a", "b", "a"], mode: "any", timeout: 1 })
    expect(body).toEqual({ timedOut: true, sessions: [] })
    expect(mocks.waitForSessions).toHaveBeenCalledWith(["a", "b"], expect.objectContaining({ mode: "any", timeoutMs: 1000 }))
  })

  it("rejects bad ids, modes and timeouts", async () => {
    expect((await call("/api/session-wait", "POST", "/", { sessionIds: [] })).status).toBe(400)
    expect((await call("/api/session-wait", "POST", "/", { sessionIds: ["a"], mode: "some" })).status).toBe(400)
    expect((await call("/api/session-wait", "GET", "/s1?timeout=-4")).status).toBe(400)
    expect(mocks.waitForSessions).not.toHaveBeenCalled()
  })
})

describe("/api/session-result", () => {
  it("returns the result, 404 for an unknown session and 400 for a bad turn", async () => {
    mocks.readSessionResult.mockResolvedValue({ sessionId: "s1" })
    expect((await call("/api/session-result/", "GET", "/s1?turn=2")).body).toEqual({ sessionId: "s1" })
    expect(mocks.readSessionResult).toHaveBeenCalledWith("s1", 2)

    mocks.readSessionResult.mockResolvedValue(null)
    expect((await call("/api/session-result/", "GET", "/s1")).status).toBe(404)
    expect((await call("/api/session-result/", "GET", "/s1?turn=x")).status).toBe(400)
  })
})

describe("/api/session-respond", () => {
  it("answers a request and maps agent errors to their status", async () => {
    mocks.respondToPendingInput.mockResolvedValue({ kind: "permission", requestId: "r1" })
    const ok = await call("/api/session-respond", "POST", "/", { sessionId: "s1", requestId: "r1", decision: "allow" })
    expect(ok.body).toEqual({ success: true, answered: { kind: "permission", requestId: "r1" } })
    expect(mocks.respondToPendingInput).toHaveBeenCalledWith("s1", "r1", { decision: "allow" })

    mocks.respondToPendingInput.mockRejectedValue(new AgentRuntimeError(404, "NOT_FOUND", "gone"))
    expect((await call("/api/session-respond", "POST", "/", { sessionId: "s1", requestId: "r1", decision: "deny" })).status).toBe(404)
  })

  it("requires ids and a recognizable answer", async () => {
    expect((await call("/api/session-respond", "POST", "/", { requestId: "r1", decision: "allow" })).status).toBe(400)
    expect((await call("/api/session-respond", "POST", "/", { sessionId: "s1", requestId: "r1", decision: "maybe" })).status).toBe(400)
  })
})

describe("pendingInputResponseFrom", () => {
  it("reads decisions, plan approvals and the three answer encodings", () => {
    expect(pendingInputResponseFrom({ decision: "allow_always" })).toEqual({ decision: "allow_always" })
    expect(pendingInputResponseFrom({ approved: true, action: "", feedback: "ok" })).toEqual({ approved: true, feedback: "ok" })
    expect(pendingInputResponseFrom({ answers: "Blue" })).toEqual({ answers: "Blue" })
    expect(pendingInputResponseFrom({ answers: ["a", "b"] })).toEqual({ answers: ["a", "b"] })
    expect(pendingInputResponseFrom({ answers: { q: "a" } })).toEqual({ answers: { q: "a" } })
    expect(pendingInputResponseFrom({ answers: [1] })).toBeNull()
  })
})

describe("/api/session-children", () => {
  it("lists the children with their state", async () => {
    mocks.sessionChildren.mockResolvedValue(["c1"])
    mocks.readSessionState.mockResolvedValue({ sessionId: "c1", outcome: "running" })
    expect((await call("/api/session-children/", "GET", "/p1")).body).toEqual({
      sessionId: "p1",
      children: [{ sessionId: "c1", outcome: "running" }],
    })
  })
})

describe("/api/session-cli", () => {
  it("runs the command in the local scope and returns its output", async () => {
    mocks.runSessionCli.mockResolvedValue({ exitCode: 0, stdout: "{}\n", stderr: "" })
    const { body } = await call("/api/session-cli", "POST", "/", {
      argv: ["status", "s1"],
      cwd: "/work",
      invocationId: "abcdef12-3456",
      callerSessionId: "parent-1",
    })
    expect(body).toEqual({ exitCode: 0, stdout: "{}\n", stderr: "" })
    expect(mocks.runSessionCli).toHaveBeenCalledWith(expect.objectContaining({
      argv: ["status", "s1"],
      cwd: "/work",
      invocationId: "abcdef12-3456",
      callerSessionId: "parent-1",
      scope: "local",
    }))
  })

  it("validates argv, cwd and the invocation id", async () => {
    const valid = { argv: ["help"], cwd: "/work", invocationId: "abcdef12-3456" }
    expect((await call("/api/session-cli", "POST", "/", { ...valid, argv: [1] })).status).toBe(400)
    expect((await call("/api/session-cli", "POST", "/", { ...valid, cwd: "relative" })).status).toBe(400)
    expect((await call("/api/session-cli", "POST", "/", { ...valid, invocationId: "short" })).status).toBe(400)
    expect(mocks.runSessionCli).not.toHaveBeenCalled()
  })
})
