// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const host = {
    id: "local",
    name: "this machine",
    remote: false,
    state: vi.fn(),
    result: vi.fn(),
    respond: vi.fn(),
    send: vi.fn(),
  }
  return {
    host,
    remote: { ...host, id: "dev_1", name: "agentbox", remote: true, state: vi.fn() },
    hostForSession: vi.fn(),
    waitAcrossHosts: vi.fn(),
    markAnswered: vi.fn(),
    sessionChildren: vi.fn(),
    runSessionCli: vi.fn(),
  }
})

vi.mock("../../sessionHosts", () => ({
  SESSION_SCOPE_HEADER: "x-cogpit-session-scope",
  hostForSession: mocks.hostForSession,
  locateSessions: async (ids: string[], options?: { localOnly?: boolean }) =>
    Promise.all(ids.map(async (sessionId) => ({ host: await mocks.hostForSession(sessionId, options), sessionId }))),
  waitAcrossHosts: mocks.waitAcrossHosts,
}))
vi.mock("../../lib/sessionOrigins", () => ({ sessionChildren: mocks.sessionChildren }))
vi.mock("../../sessionCli/commands", () => ({ runSessionCli: mocks.runSessionCli }))
vi.mock("../../sessionHosts/delegatedRequests", () => ({
  listDelegatedRequests: (parent: string) => [{ sessionId: "r1", parentSessionId: parent, waiting: [] }],
  markDelegatedRequestAnswered: mocks.markAnswered,
  watchDelegatedRequestsOf: vi.fn(),
}))

import { AgentRuntimeError } from "../../agents/runtimeTypes"
import { DeviceRequestError } from "../../hub/deviceRequest"
import { DeviceUnreachableError } from "../../hub/device-client"
import { pendingInputResponseFrom, registerSessionOrchestrationRoutes } from "../../routes/session-orchestration"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"

async function call(path: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const handler = getRouteHandler(collectRoutes(registerSessionOrchestrationRoutes), path)
  const { req, res, next, sendBody } = createMockReqRes(method, url, body === undefined ? {} : { body: JSON.stringify(body) })
  Object.assign(req.headers, headers)
  Object.assign(res, { on: vi.fn() })
  const done = handler(req, res, next)
  sendBody()
  await done
  await vi.waitFor(() => expect(res.end.mock.calls.length + next.mock.calls.length).toBeGreaterThan(0))
  return { status: res._getStatus(), body: JSON.parse(res._getData() || "null"), next }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hostForSession.mockImplementation(async (id: string) => (id.startsWith("r") ? mocks.remote : mocks.host))
})

describe("/api/session-wait", () => {
  it("waits on one session from the path with the requested timeout", async () => {
    mocks.waitAcrossHosts.mockResolvedValue({ timedOut: false, sessions: [{ sessionId: "s1", outcome: "completed" }] })
    const { status, body } = await call("/api/session-wait", "GET", "/s1?timeout=5")
    expect(status).toBe(200)
    expect(body).toEqual({ timedOut: false, sessionId: "s1", outcome: "completed" })
    expect(mocks.waitAcrossHosts).toHaveBeenCalledWith(
      [{ host: mocks.host, sessionId: "s1" }],
      expect.objectContaining({ mode: "all", timeoutMs: 5000 }),
    )
  })

  it("waits on several sessions, deduplicated, in any mode", async () => {
    mocks.waitAcrossHosts.mockResolvedValue({ timedOut: true, sessions: [] })
    const { body } = await call("/api/session-wait", "POST", "/", { sessionIds: ["a", "r2", "a"], mode: "any", timeout: 1 })
    expect(body).toEqual({ timedOut: true, sessions: [] })
    expect(mocks.waitAcrossHosts).toHaveBeenCalledWith(
      [{ host: mocks.host, sessionId: "a" }, { host: mocks.remote, sessionId: "r2" }],
      expect.objectContaining({ mode: "any", timeoutMs: 1000 }),
    )
  })

  it("answers for this machine only when a hub asks", async () => {
    mocks.waitAcrossHosts.mockResolvedValue({ timedOut: true, sessions: [] })
    await call("/api/session-wait", "POST", "/", { sessionIds: ["a"] }, { "x-cogpit-session-scope": "local" })
    expect(mocks.hostForSession).toHaveBeenCalledWith("a", { localOnly: true })
  })

  it("rejects bad ids, modes and timeouts", async () => {
    expect((await call("/api/session-wait", "POST", "/", { sessionIds: [] })).status).toBe(400)
    expect((await call("/api/session-wait", "POST", "/", { sessionIds: ["a"], mode: "some" })).status).toBe(400)
    expect((await call("/api/session-wait", "GET", "/s1?timeout=-4")).status).toBe(400)
    expect(mocks.waitAcrossHosts).not.toHaveBeenCalled()
  })
})

describe("/api/session-result", () => {
  it("returns the result, 404 for an unknown session and 400 for a bad turn", async () => {
    mocks.host.result.mockResolvedValue({ sessionId: "s1" })
    expect((await call("/api/session-result/", "GET", "/s1?turn=2")).body).toEqual({ sessionId: "s1" })
    expect(mocks.host.result).toHaveBeenCalledWith("s1", 2)

    mocks.host.result.mockResolvedValue(null)
    expect((await call("/api/session-result/", "GET", "/s1")).status).toBe(404)
    expect((await call("/api/session-result/", "GET", "/s1?turn=x")).status).toBe(400)
  })
})

describe("/api/session-respond", () => {
  it("answers a request and maps agent errors to their status", async () => {
    mocks.host.respond.mockResolvedValue({ kind: "permission", requestId: "r1" })
    const ok = await call("/api/session-respond", "POST", "/", { sessionId: "s1", requestId: "r1", decision: "allow" })
    expect(ok.body).toEqual({ success: true, answered: { kind: "permission", requestId: "r1" } })
    expect(mocks.host.respond).toHaveBeenCalledWith("s1", "r1", { decision: "allow" })
    expect(mocks.markAnswered).toHaveBeenCalledWith("s1", "r1")

    mocks.host.respond.mockRejectedValue(new AgentRuntimeError(404, "NOT_FOUND", "gone"))
    expect((await call("/api/session-respond", "POST", "/", { sessionId: "s1", requestId: "r1", decision: "deny" })).status).toBe(404)
  })

  it("passes a device's refusal through and reports a silent device as 502", async () => {
    mocks.host.respond.mockRejectedValueOnce(new DeviceRequestError("dev_1", 404, "No pending request", "NOT_FOUND"))
    expect(await call("/api/session-respond", "POST", "/", { sessionId: "s1", requestId: "r1", decision: "deny" }))
      .toMatchObject({ status: 404, body: { error: "No pending request", code: "NOT_FOUND" } })
    mocks.host.respond.mockRejectedValueOnce(new DeviceUnreachableError("dev_1", "Could not reach device"))
    expect(await call("/api/session-respond", "POST", "/", { sessionId: "s1", requestId: "r1", decision: "deny" }))
      .toMatchObject({ status: 502, body: { code: "DEVICE_UNREACHABLE" } })
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
    mocks.sessionChildren.mockResolvedValue(["c1", "r2"])
    mocks.host.state.mockResolvedValue({ sessionId: "c1", outcome: "running" })
    mocks.remote.state.mockResolvedValue({ sessionId: "r2", outcome: "needs_input" })
    expect((await call("/api/session-children/", "GET", "/p1")).body).toEqual({
      sessionId: "p1",
      children: [
        { sessionId: "c1", outcome: "running" },
        { sessionId: "r2", outcome: "needs_input", device: { id: "dev_1", name: "agentbox" } },
      ],
    })
  })
})

describe("/api/session-requests", () => {
  it("lists what a parent's delegated sessions ask the user", async () => {
    expect((await call("/api/session-requests", "GET", "/?parent=p1")).body).toEqual({
      requests: [{ sessionId: "r1", parentSessionId: "p1", waiting: [] }],
    })
    expect((await call("/api/session-requests", "GET", "/")).status).toBe(400)
  })
})

describe("/api/session-send", () => {
  it("delivers a follow-up without waiting for the turn", async () => {
    mocks.host.send.mockResolvedValue({ delivery: "started" })
    const { body } = await call("/api/session-send", "POST", "/", { sessionId: "s1", message: "go on", interrupt: true })
    expect(body).toEqual({ delivery: "started" })
    expect(mocks.host.send).toHaveBeenCalledWith("s1", "go on", { interrupt: true })
    expect((await call("/api/session-send", "POST", "/", { sessionId: "s1", message: " " })).status).toBe(400)
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
