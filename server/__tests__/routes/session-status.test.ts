// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

const mockFindJsonlPath = vi.hoisted(() => vi.fn())
const mockGetSessionStatus = vi.hoisted(() => vi.fn())
const mockPersistentSessions = vi.hoisted(() => new Map<string, { dead: boolean }>())
const mockActiveProcesses = vi.hoisted(() => new Map<string, unknown>())
const mockSdkSessions = vi.hoisted(() => new Map<string, { running: boolean }>())
const mockIsSDKQueryLive = vi.hoisted(() => vi.fn())
const mockGetActiveTurnId = vi.hoisted(() => vi.fn())
const mockIsCopilotSessionActive = vi.hoisted(() => vi.fn())
const mockIsCopilotTurnActive = vi.hoisted(() => vi.fn())

vi.mock("../../helpers", () => ({
  getSessionStatus: mockGetSessionStatus,
  persistentSessions: mockPersistentSessions,
  activeProcesses: mockActiveProcesses,
  join: (...parts: string[]) => parts.join("/"),
  homedir: () => "/Users/me",
}))

vi.mock("../../processRegistry", () => ({
  persistentSessions: mockPersistentSessions,
  activeProcesses: mockActiveProcesses,
  terminateTrackedSession: vi.fn(() => false),
  killTrackedProcesses: vi.fn(() => 0),
}))

vi.mock("../../sessionPaths", () => ({
  findJsonlPath: mockFindJsonlPath,
  findNewestCodexSessionForCwd: vi.fn().mockResolvedValue(null),
}))

// Which agent owns the session is decided by whose storage its transcript is
// in, so each case below says where the file lives rather than naming a kind.
const ROOTS: Record<string, string> = {
  claude: "/tmp/projects",
  codex: "/tmp/codex/sessions",
  copilot: "/tmp/copilot/session-state",
}
const CLAUDE_TRANSCRIPT = `${ROOTS.claude}/-tmp-app/abc.jsonl`
const CODEX_TRANSCRIPT = `${ROOTS.codex}/2026/09/01/rollout-2026-09-01T10-00-00-abc.jsonl`
const COPILOT_TRANSCRIPT = `${ROOTS.copilot}/abc/events.jsonl`

vi.mock("../../agents", () => ({
  storeFor: (kind: string) => ({
    kind,
    sessionsRoot: () => ROOTS[kind],
    listSessionFiles: vi.fn().mockResolvedValue([]),
  }),
  storeForPath: (filePath: string | null) => {
    if (!filePath) return null
    const kind = Object.keys(ROOTS).find((key) => filePath.startsWith(`${ROOTS[key]}/`))
    return kind ? { kind } : null
  },
}))

vi.mock("../../sdk-session", () => ({
  sdkSessions: mockSdkSessions,
  isSDKQueryLive: mockIsSDKQueryLive,
}))

vi.mock("../../agents/codexAppServer", () => ({
  codexAppServer: {
    getActiveTurnId: mockGetActiveTurnId,
    listApprovalThreadIds: vi.fn(() => []),
    listActiveTurns: vi.fn(() => []),
  },
}))

vi.mock("../../agents/copilotTransport", () => ({
  copilotRuntime: {
    isSessionActive: mockIsCopilotSessionActive,
    isTurnActive: mockIsCopilotTurnActive,
    getPendingPermissions: vi.fn(() => []),
    getPendingUserInputs: vi.fn(() => []),
    getActiveSessionIds: vi.fn(() => []),
  },
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
    mockFindJsonlPath.mockResolvedValue(CLAUDE_TRANSCRIPT)
    mockGetSessionStatus.mockResolvedValue({ status: "completed" })
    mockIsSDKQueryLive.mockReturnValue(false)
    mockGetActiveTurnId.mockReturnValue(undefined)
    mockIsCopilotSessionActive.mockReturnValue(false)
    mockIsCopilotTurnActive.mockReturnValue(false)
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
    // Only the pre-app-server Codex CLI ever puts a child in this registry.
    mockFindJsonlPath.mockResolvedValue(CODEX_TRANSCRIPT)
    mockPersistentSessions.set("abc", { dead: true })
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: false, running: false })

    mockPersistentSessions.set("abc", { dead: false })
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: true, running: false })
  })

  it("reports running=true for a tracked one-shot process", async () => {
    mockActiveProcesses.set("abc", { pid: 123 })
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: false, running: true })
  })

  it("ignores another agent's live turn for a session it does not own", async () => {
    // The old union asked every runtime about every id, so an unrelated Codex
    // turn made a Claude session read as running.
    mockGetActiveTurnId.mockReturnValue("turn-1")
    mockIsCopilotSessionActive.mockReturnValue(true)
    expect((await request("GET", "/abc")).json()).toMatchObject({
      live: false,
      running: false,
    })
  })

  it("reports live=true running=true for an active native Codex turn", async () => {
    mockFindJsonlPath.mockResolvedValue(CODEX_TRANSCRIPT)
    mockGetActiveTurnId.mockReturnValue("turn-1")
    expect((await request("GET", "/abc")).json()).toMatchObject({ live: true, running: true })
  })

  it("reports live=true running=false between turns of an open Copilot session", async () => {
    mockFindJsonlPath.mockResolvedValue(COPILOT_TRANSCRIPT)
    mockIsCopilotSessionActive.mockReturnValue(true)

    expect((await request("GET", "/abc")).json()).toMatchObject({
      live: true,
      running: false,
    })
  })

  it("reports live=true running=true while a Copilot turn is in flight", async () => {
    mockFindJsonlPath.mockResolvedValue(COPILOT_TRANSCRIPT)
    mockIsCopilotSessionActive.mockReturnValue(true)
    mockIsCopilotTurnActive.mockReturnValue(true)

    expect((await request("GET", "/abc")).json()).toMatchObject({
      live: true,
      running: true,
    })
  })

  it("returns 500 when the status scan fails", async () => {
    mockGetSessionStatus.mockRejectedValue(new Error("boom"))
    const { res } = await request("GET", "/abc")
    expect(res.statusCode).toBe(500)
  })
})
