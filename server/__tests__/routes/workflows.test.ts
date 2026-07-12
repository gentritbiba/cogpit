// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

const { activeProcesses, persistentSessions, sdkSessions } = vi.hoisted(() => ({
  activeProcesses: new Map<string, { kill: ReturnType<typeof vi.fn> }>(),
  persistentSessions: new Map<string, { dead: boolean; proc: { kill: ReturnType<typeof vi.fn> } }>(),
  sdkSessions: new Map<string, unknown>(),
}))

vi.mock("../../helpers", () => ({
  dirs: { PROJECTS_DIR: "/projects" },
  isWithinDir: vi.fn(() => true),
  join: (...parts: string[]) => parts.join("/"),
  watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
  readdir: vi.fn(),
  readFile: vi.fn(),
  activeProcesses,
  persistentSessions,
}))

vi.mock("../../sdk-session", () => ({
  sdkSessions,
  stopSDKSession: vi.fn(() => false),
}))

import { isWithinDir, readdir, readFile } from "../../helpers"
import { stopSDKSession } from "../../sdk-session"
import type { UseFn, Middleware } from "../../helpers"
import { registerWorkflowRoutes } from "../../routes/workflows"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedReaddir = vi.mocked(readdir)
const mockedReadFile = vi.mocked(readFile)
const mockedStopSDK = vi.mocked(stopSDKSession)

function createMockReqRes(method: string, url: string, body?: string) {
  const dataHandlers: ((chunk: string) => void)[] = []
  const endHandlers: (() => void)[] = []
  const closeHandlers: (() => void)[] = []
  let endData = ""
  let statusCode = 200
  const headers: Record<string, string> = {}
  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: string) => void)
      if (event === "end") endHandlers.push(handler as () => void)
      if (event === "close") closeHandlers.push(handler as () => void)
      return req
    }),
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  }
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn((name: string, value: string) => { headers[name] = value }),
    end: vi.fn((data?: string) => { endData = data || "" }),
    write: vi.fn(),
    writeHead: vi.fn(),
    _getData: () => endData,
    _getStatus: () => statusCode,
  }
  const next = vi.fn()
  const sendBody = () => {
    if (body) for (const h of dataHandlers) h(body)
    for (const h of endHandlers) h()
  }
  return { req, res, next, sendBody }
}

const journalJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    runId: "wf_abc-123",
    workflowName: "review",
    summary: "s",
    status: "running",
    startTime: 10,
    agentCount: 1,
    phases: [{ title: "Map" }],
    workflowProgress: [
      { type: "workflow_agent", index: 1, label: "a", phaseIndex: 1, phaseTitle: "Map", agentId: "a1", state: "running" },
    ],
    ...over,
  })

describe("workflow routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    activeProcesses.clear()
    persistentSessions.clear()
    sdkSessions.clear()
    mockedIsWithinDir.mockReturnValue(true)
    mockedStopSDK.mockReturnValue(false)
    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => { handlers.set(path, handler) }
    registerWorkflowRoutes(use)
  })

  describe("GET /api/workflows/:dirName/:sessionId", () => {
    it("calls next for non-GET", async () => {
      const { req, res, next } = createMockReqRes("POST", "/proj/sess")
      await handlers.get("/api/workflows/")!(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("calls next when arity is wrong", async () => {
      const { req, res, next } = createMockReqRes("GET", "/proj")
      await handlers.get("/api/workflows/")!(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 403 when path escapes PROJECTS_DIR", async () => {
      mockedIsWithinDir.mockReturnValue(false)
      const { req, res, next } = createMockReqRes("GET", "/proj/sess")
      await handlers.get("/api/workflows/")!(req, res, next)
      expect(res._getStatus()).toBe(403)
    })

    it("lists workflows for the session", async () => {
      mockedReaddir.mockResolvedValueOnce(["wf_abc-123.json"] as never)
      mockedReadFile.mockResolvedValueOnce(journalJson())
      const { req, res, next } = createMockReqRes("GET", "/proj/sess")
      await handlers.get("/api/workflows/")!(req, res, next)
      const data = JSON.parse(res._getData())
      expect(Array.isArray(data)).toBe(true)
      expect(data[0].runId).toBe("wf_abc-123")
    })

    it("returns [] when the session has no workflows dir", async () => {
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))
      const { req, res, next } = createMockReqRes("GET", "/proj/sess")
      await handlers.get("/api/workflows/")!(req, res, next)
      expect(JSON.parse(res._getData())).toEqual([])
    })
  })

  describe("GET /api/workflow-detail/:dirName/:sessionId/:runId", () => {
    it("returns 404 when the journal is missing", async () => {
      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))
      const { req, res, next } = createMockReqRes("GET", "/proj/sess/wf_abc-123")
      await handlers.get("/api/workflow-detail/")!(req, res, next)
      expect(res._getStatus()).toBe(404)
    })

    it("returns detail with controllable=false when session is not managed", async () => {
      mockedReadFile.mockResolvedValueOnce(journalJson())
      const { req, res, next } = createMockReqRes("GET", "/proj/sess/wf_abc-123")
      await handlers.get("/api/workflow-detail/")!(req, res, next)
      const data = JSON.parse(res._getData())
      expect(data.runId).toBe("wf_abc-123")
      expect(data.controllable).toBe(false)
    })

    it("reports controllable=true when the owning session is active", async () => {
      activeProcesses.set("sess", { kill: vi.fn() })
      mockedReadFile.mockResolvedValueOnce(journalJson())
      const { req, res, next } = createMockReqRes("GET", "/proj/sess/wf_abc-123")
      await handlers.get("/api/workflow-detail/")!(req, res, next)
      expect(JSON.parse(res._getData()).controllable).toBe(true)
    })
  })

  describe("POST /api/workflow-stop", () => {
    it("returns 400 when sessionId is missing", async () => {
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", JSON.stringify({ runId: "wf_abc-123" }))
      await handlers.get("/api/workflow-stop")!(req, res, next)
      sendBody()
      expect(res._getStatus()).toBe(400)
    })

    it("reports controllable=false for an unmanaged session", async () => {
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", JSON.stringify({ sessionId: "ghost", runId: "wf_abc-123" }))
      await handlers.get("/api/workflow-stop")!(req, res, next)
      sendBody()
      const data = JSON.parse(res._getData())
      expect(data.success).toBe(false)
      expect(data.controllable).toBe(false)
    })

    it("kills the owning active process and reports success", async () => {
      const kill = vi.fn()
      activeProcesses.set("sess", { kill })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", JSON.stringify({ sessionId: "sess", runId: "wf_abc-123" }))
      await handlers.get("/api/workflow-stop")!(req, res, next)
      sendBody()
      const data = JSON.parse(res._getData())
      expect(data.success).toBe(true)
      expect(data.controllable).toBe(true)
      expect(kill).toHaveBeenCalledWith("SIGTERM")
    })
  })
})
