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
  stat: vi.fn(),
  activeProcesses,
  persistentSessions,
}))

vi.mock("../../sdk-session", () => ({
  sdkSessions,
  stopSDKSession: vi.fn(() => false),
}))

import { isWithinDir, readdir, readFile, stat } from "../../helpers"
import { stopSDKSession } from "../../sdk-session"
import type { Middleware } from "../../helpers"
import { collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerWorkflowRoutes } from "../../routes/workflows"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedReaddir = vi.mocked(readdir)
const mockedReadFile = vi.mocked(readFile)
const mockedStat = vi.mocked(stat)
const mockedStopSDK = vi.mocked(stopSDKSession)

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

/**
 * Drain the microtask queue that withJsonBody parses on. Deliberately not
 * setImmediate: several tests here run with fake timers, which never fire it.
 * readJsonBody settles through promises only, so yielding is enough.
 */
async function drainBodyParse() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

describe("workflow routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    activeProcesses.clear()
    persistentSessions.clear()
    sdkSessions.clear()
    mockedIsWithinDir.mockReturnValue(true)
    mockedStopSDK.mockReturnValue(false)
    handlers = collectRoutes(registerWorkflowRoutes)
  })

  describe("GET /api/workflows/:dirName/:sessionId", () => {
    it("calls next for non-GET", async () => {
      const { req, res, next } = createMockReqRes("POST", "/proj/sess")
      await getRouteHandler(handlers, "/api/workflows/")(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("calls next when arity is wrong", async () => {
      const { req, res, next } = createMockReqRes("GET", "/proj")
      await getRouteHandler(handlers, "/api/workflows/")(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 403 when path escapes PROJECTS_DIR", async () => {
      mockedIsWithinDir.mockReturnValue(false)
      const { req, res, next } = createMockReqRes("GET", "/proj/sess")
      await getRouteHandler(handlers, "/api/workflows/")(req, res, next)
      expect(res._getStatus()).toBe(403)
    })

    it("lists workflows for the session", async () => {
      mockedReaddir
        .mockResolvedValueOnce(["wf_abc-123.json"] as never)
        .mockResolvedValueOnce([] as never)
      mockedReadFile.mockResolvedValueOnce(journalJson())
      const { req, res, next } = createMockReqRes("GET", "/proj/sess")
      await getRouteHandler(handlers, "/api/workflows/")(req, res, next)
      const data = JSON.parse(res._getData())
      expect(Array.isArray(data)).toBe(true)
      expect(data[0].runId).toBe("wf_abc-123")
    })

    it("returns [] when the session has no workflows dir", async () => {
      mockedReaddir
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockRejectedValueOnce(new Error("ENOENT"))
      const { req, res, next } = createMockReqRes("GET", "/proj/sess")
      await getRouteHandler(handlers, "/api/workflows/")(req, res, next)
      expect(JSON.parse(res._getData())).toEqual([])
    })

    it("lists a running workflow from its live event journal", async () => {
      mockedReaddir
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce(["wf_live-123"] as never)
      mockedReadFile
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockResolvedValueOnce(JSON.stringify({ type: "started", key: "one", agentId: "agent-1" }))
      mockedStat.mockResolvedValueOnce({ birthtimeMs: 1234, ctimeMs: 1234 } as never)
      const { req, res, next } = createMockReqRes("GET", "/proj/sess")

      await getRouteHandler(handlers, "/api/workflows/")(req, res, next)

      expect(JSON.parse(res._getData())).toMatchObject([{
        runId: "wf_live-123",
        status: "running",
        agentCount: 1,
      }])
    })
  })

  describe("GET /api/workflow-detail/:dirName/:sessionId/:runId", () => {
    it("returns 404 when the journal is missing", async () => {
      mockedReadFile
        .mockRejectedValueOnce(new Error("ENOENT"))
        .mockRejectedValueOnce(new Error("ENOENT"))
      const { req, res, next } = createMockReqRes("GET", "/proj/sess/wf_abc-123")
      await getRouteHandler(handlers, "/api/workflow-detail/")(req, res, next)
      expect(res._getStatus()).toBe(404)
    })

    it("returns detail with controllable=false when session is not managed", async () => {
      mockedReadFile.mockResolvedValueOnce(journalJson())
      const { req, res, next } = createMockReqRes("GET", "/proj/sess/wf_abc-123")
      await getRouteHandler(handlers, "/api/workflow-detail/")(req, res, next)
      const data = JSON.parse(res._getData())
      expect(data.runId).toBe("wf_abc-123")
      expect(data.controllable).toBe(false)
    })

    it("reports controllable=true when the owning session is active", async () => {
      activeProcesses.set("sess", { kill: vi.fn() })
      mockedReadFile.mockResolvedValueOnce(journalJson())
      const { req, res, next } = createMockReqRes("GET", "/proj/sess/wf_abc-123")
      await getRouteHandler(handlers, "/api/workflow-detail/")(req, res, next)
      expect(JSON.parse(res._getData()).controllable).toBe(true)
    })
  })

  describe("GET /api/workflow-agent-result/:dirName/:sessionId/:runId/:agentId", () => {
    it("returns the complete structured result", async () => {
      mockedReadFile.mockResolvedValueOnce([
        JSON.stringify({ type: "started", agentId: "agent-1" }),
        JSON.stringify({
          type: "result",
          agentId: "agent-1",
          result: { headline: "The useful answer", findings: [{ title: "First" }] },
        }),
      ].join("\n"))
      const { req, res, next } = createMockReqRes(
        "GET",
        "/proj/sess/wf_abc-123/agent-1",
      )

      await getRouteHandler(handlers, "/api/workflow-agent-result/")(req, res, next)

      expect(JSON.parse(res._getData())).toEqual({
        result: { headline: "The useful answer", findings: [{ title: "First" }] },
      })
    })

    it("returns 404 when the result is unavailable", async () => {
      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))
      const { req, res, next } = createMockReqRes(
        "GET",
        "/proj/sess/wf_abc-123/agent-1",
      )

      await getRouteHandler(handlers, "/api/workflow-agent-result/")(req, res, next)

      expect(res._getStatus()).toBe(404)
    })
  })

  describe("GET /api/workflow-result/:dirName/:sessionId/:runId", () => {
    it("returns the complete synthesized result", async () => {
      mockedReadFile.mockResolvedValueOnce(journalJson({
        result: { recommendation: "Keep the useful parts" },
      }))
      const { req, res, next } = createMockReqRes("GET", "/proj/sess/wf_abc-123")

      await getRouteHandler(handlers, "/api/workflow-result/")(req, res, next)

      expect(JSON.parse(res._getData())).toEqual({
        result: { recommendation: "Keep the useful parts" },
      })
    })
  })

  describe("POST /api/workflow-stop", () => {
    it("returns 400 when sessionId is missing", async () => {
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", { body: JSON.stringify({ runId: "wf_abc-123" }) })
      await getRouteHandler(handlers, "/api/workflow-stop")(req, res, next)
      sendBody()
      await drainBodyParse()
      expect(res._getStatus()).toBe(400)
    })

    it("reports controllable=false for an unmanaged session", async () => {
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", { body: JSON.stringify({ sessionId: "ghost", runId: "wf_abc-123" }) })
      await getRouteHandler(handlers, "/api/workflow-stop")(req, res, next)
      sendBody()
      await drainBodyParse()
      const data = JSON.parse(res._getData())
      expect(data.success).toBe(false)
      expect(data.controllable).toBe(false)
    })

    it("kills the owning active process and reports success", async () => {
      const kill = vi.fn()
      activeProcesses.set("sess", { kill })
      const { req, res, next, sendBody } = createMockReqRes("POST", "/", { body: JSON.stringify({ sessionId: "sess", runId: "wf_abc-123" }) })
      await getRouteHandler(handlers, "/api/workflow-stop")(req, res, next)
      sendBody()
      await drainBodyParse()
      const data = JSON.parse(res._getData())
      expect(data.success).toBe(true)
      expect(data.controllable).toBe(true)
      expect(kill).toHaveBeenCalledWith("SIGTERM")
    })
  })
})
