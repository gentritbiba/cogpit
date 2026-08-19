// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockFindJsonlPath = vi.hoisted(() => vi.fn())
const mockGetSessionStatus = vi.hoisted(() => vi.fn())
const mockPersistentSessions = vi.hoisted(() => new Map<string, { dead: boolean }>())
const mockActiveProcesses = vi.hoisted(() => new Map<string, unknown>())
const mockSdkSessions = vi.hoisted(() => new Map<string, { running: boolean }>())
const mockIsSDKQueryLive = vi.hoisted(() => vi.fn())
const mockGetActiveTurnId = vi.hoisted(() => vi.fn())

vi.mock("../../helpers", () => ({
  findJsonlPath: mockFindJsonlPath,
  getSessionStatus: mockGetSessionStatus,
  persistentSessions: mockPersistentSessions,
  activeProcesses: mockActiveProcesses,
}))

vi.mock("../../sdk-session", () => ({
  sdkSessions: mockSdkSessions,
  isSDKQueryLive: mockIsSDKQueryLive,
}))

vi.mock("../../codex-app-server", () => ({
  codexAppServer: { getActiveTurnId: mockGetActiveTurnId },
}))

import type { UseFn, Middleware } from "../../helpers"
import { asIncomingMessage, asServerResponse, getRouteHandler } from "../http-fixtures"
import { registerSessionStatusRoutes } from "../../routes/session-status"

function buildHandler(): Middleware {
  const handlers = new Map<string, Middleware>()
  const use: UseFn = (path, handler) => {
    handlers.set(path, handler)
  }
  registerSessionStatusRoutes(use)
  return getRouteHandler(handlers, "/api/session-status/")
}

async function request(method: string, url: string) {
  let body = ""
  const res = asServerResponse({
    statusCode: 200,
    setHeader: vi.fn(),
    end: (data?: string) => { body = data ?? "" },
  })
  const next = vi.fn()
  await buildHandler()(asIncomingMessage({ method, url }), res, next)
  return { res, next, json: () => JSON.parse(body) }
}

describe("GET /api/session-status/:sessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPersistentSessions.clear()
    mockActiveProcesses.clear()
    mockSdkSessions.clear()
    mockFindJsonlPath.mockResolvedValue("/tmp/projects/-tmp-app/abc.jsonl")
    mockGetSessionStatus.mockResolvedValue({ status: "completed" })
    mockIsSDKQueryLive.mockReturnValue(false)
    mockGetActiveTurnId.mockReturnValue(undefined)
  })

  it("delegates non-GET requests and nested paths to next()", async () => {
    const post = await request("POST", "/abc")
    expect(post.next).toHaveBeenCalledOnce()

    const nested = await request("GET", "/abc/turn/2")
    expect(nested.next).toHaveBeenCalledOnce()
  })

  it("returns 404 when no JSONL exists for the session", async () => {
    mockFindJsonlPath.mockResolvedValue(null)
    const { res, json } = await request("GET", "/missing-session")
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: "Session not found" })
  })

  it("reports tail-derived status with live=false running=false when nothing is tracked", async () => {
    const { res, json } = await request("GET", "/abc")
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ sessionId: "abc", live: false, running: false, status: "completed" })
  })

  it("passes toolName and terminalReason through from the status scan", async () => {
    mockGetSessionStatus.mockResolvedValue({
      status: "completed",
      terminalReason: "max_turns",
    })
    const { json } = await request("GET", "/abc")
    expect(json()).toEqual({
      sessionId: "abc",
      live: false,
      running: false,
      status: "completed",
      terminalReason: "max_turns",
    })
  })

  it("reports live=true running=false between turns of an open SDK session", async () => {
    // The stale-tail race: the query is held open for follow-ups but no turn
    // is in flight. running must NOT be inferred from query liveness.
    mockSdkSessions.set("abc", { running: false })
    mockIsSDKQueryLive.mockReturnValue(true)

    const { json } = await request("GET", "/abc")
    expect(json()).toEqual({ sessionId: "abc", live: true, running: false, status: "completed" })
    expect(mockIsSDKQueryLive).toHaveBeenCalledWith(mockSdkSessions.get("abc"))
  })

  it("reports running=true while an SDK turn is in flight", async () => {
    mockSdkSessions.set("abc", { running: true })
    mockIsSDKQueryLive.mockReturnValue(true)
    mockGetSessionStatus.mockResolvedValue({ status: "tool_use", toolName: "Bash" })

    const { json } = await request("GET", "/abc")
    expect(json()).toEqual({
      sessionId: "abc",
      live: true,
      running: true,
      status: "tool_use",
      toolName: "Bash",
    })
  })

  it("reports live=true for a tracked legacy process, but not a dead one", async () => {
    mockPersistentSessions.set("abc", { dead: true })
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: false, running: false })

    mockPersistentSessions.set("abc", { dead: false })
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: true, running: false })
  })

  it("reports running=true for a tracked one-shot process", async () => {
    mockActiveProcesses.set("abc", { pid: 123 })
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: false, running: true })
  })

  it("reports live=true running=true for an active native Codex turn", async () => {
    mockGetActiveTurnId.mockReturnValue("turn-1")
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: true, running: true })
  })

  it("returns 500 when the status scan fails", async () => {
    mockGetSessionStatus.mockRejectedValue(new Error("boom"))
    const { res } = await request("GET", "/abc")
    expect(res.statusCode).toBe(500)
  })
})
