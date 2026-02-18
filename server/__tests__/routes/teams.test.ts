// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Dirent, FSWatcher } from "node:fs"

vi.mock("../../helpers", () => ({
  dirs: {
    TEAMS_DIR: "/tmp/test-teams",
    TASKS_DIR: "/tmp/test-tasks",
  },
  isWithinDir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
  watch: vi.fn(),
}))

import {
  isWithinDir,
  readdir,
  readFile,
  writeFile,
  watch,
} from "../../helpers"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedReaddir = vi.mocked(readdir)
const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFile)
const mockedWatch = vi.mocked(watch)

import type { UseFn, Middleware } from "../../helpers"
import { registerTeamRoutes } from "../../routes/teams"

function createMockReqRes(method: string, url: string, body?: string) {
  const dataHandlers: ((chunk: string) => void)[] = []
  const endHandlers: (() => void)[] = []
  let endData = ""
  let statusCode = 200
  const headers: Record<string, string> = {}
  const req = {
    method,
    url,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: string) => void)
      if (event === "end") endHandlers.push(handler as () => void)
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
    _getHeaders: () => headers,
  }
  const next = vi.fn()
  const sendBody = () => {
    if (body) {
      for (const h of dataHandlers) h(body)
    }
    for (const h of endHandlers) h()
  }
  return { req, res, next, sendBody }
}

describe("team routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.resetAllMocks()
    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => {
      handlers.set(path, handler)
    }
    registerTeamRoutes(use)
  })

  // ── GET /api/teams ────────────────────────────────────────────────────

  describe("GET /api/teams", () => {
    it("calls next for non-GET methods", async () => {
      const handler = handlers.get("/api/teams")
      const { req, res, next } = createMockReqRes("POST", "/")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("calls next for sub-paths", async () => {
      const handler = handlers.get("/api/teams")
      const { req, res, next } = createMockReqRes("GET", "/something")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns empty array when TEAMS_DIR does not exist", async () => {
      const handler = handlers.get("/api/teams")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })

    it("lists teams with task summaries sorted by createdAt", async () => {
      const handler = handlers.get("/api/teams")
      const { req, res, next } = createMockReqRes("GET", "/")

      // readdir for TEAMS_DIR
      mockedReaddir.mockResolvedValueOnce([
        { name: "team-alpha", isDirectory: () => true },
        { name: "team-beta", isDirectory: () => true },
      ] as unknown as Dirent[])

      // team-alpha config
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        name: "alpha",
        description: "Team Alpha",
        createdAt: 1000,
        members: [
          { name: "lead", agentType: "team-lead" },
          { name: "worker", agentType: "agent" },
        ],
      }) as unknown as Buffer)

      // team-alpha tasks
      mockedReaddir.mockResolvedValueOnce(["1.json", "2.json"] as unknown as Dirent[])
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ status: "completed" }) as unknown as Buffer)
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ status: "in_progress" }) as unknown as Buffer)

      // team-beta config
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        name: "beta",
        createdAt: 2000,
        members: [{ name: "boss", agentType: "team-lead" }],
      }) as unknown as Buffer)

      // team-beta tasks (no task dir)
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toHaveLength(2)
      // beta has higher createdAt, should be first
      expect(response[0].name).toBe("beta")
      expect(response[0].leadName).toBe("boss")
      expect(response[0].taskSummary.total).toBe(0)
      expect(response[1].name).toBe("alpha")
      expect(response[1].leadName).toBe("lead")
      expect(response[1].memberCount).toBe(2)
      expect(response[1].taskSummary.total).toBe(2)
      expect(response[1].taskSummary.completed).toBe(1)
      expect(response[1].taskSummary.inProgress).toBe(1)
    })

    it("skips deleted tasks in task summary", async () => {
      const handler = handlers.get("/api/teams")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockResolvedValueOnce([
        { name: "team-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        name: "a",
        createdAt: 1000,
        members: [{ name: "lead", agentType: "team-lead" }],
      }) as unknown as Buffer)
      mockedReaddir.mockResolvedValueOnce(["1.json", "2.json"] as unknown as Dirent[])
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ status: "deleted" }) as unknown as Buffer)
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ status: "pending" }) as unknown as Buffer)

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response[0].taskSummary.total).toBe(1)
      expect(response[0].taskSummary.pending).toBe(1)
    })

    it("skips teams with bad config", async () => {
      const handler = handlers.get("/api/teams")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockResolvedValueOnce([
        { name: "bad-team", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })
  })

  // ── GET /api/team-detail/:teamName ────────────────────────────────────

  describe("GET /api/team-detail/:teamName", () => {
    it("calls next for non-GET methods", async () => {
      const handler = handlers.get("/api/team-detail/")
      const { req, res, next } = createMockReqRes("POST", "my-team")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 403 for paths outside TEAMS_DIR", async () => {
      const handler = handlers.get("/api/team-detail/")
      const { req, res, next } = createMockReqRes("GET", "../../etc")
      mockedIsWithinDir.mockReturnValueOnce(false)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(403)
    })

    it("returns full team detail with config, tasks, and inboxes", async () => {
      const handler = handlers.get("/api/team-detail/")
      const { req, res, next } = createMockReqRes("GET", "my-team")
      mockedIsWithinDir.mockReturnValueOnce(true)

      // config
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        name: "my-team",
        members: [{ name: "lead", agentType: "team-lead" }],
      }) as unknown as Buffer)

      // tasks
      mockedReaddir.mockResolvedValueOnce(["1.json"] as unknown as Dirent[])
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        id: "1", subject: "Test", status: "pending",
      }) as unknown as Buffer)

      // inboxes
      mockedReaddir.mockResolvedValueOnce(["lead.json"] as unknown as Dirent[])
      mockedReadFile.mockResolvedValueOnce(JSON.stringify([
        { from: "user", text: "hello" },
      ]) as unknown as Buffer)

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.config.name).toBe("my-team")
      expect(response.tasks).toHaveLength(1)
      expect(response.tasks[0].subject).toBe("Test")
      expect(response.inboxes.lead).toHaveLength(1)
    })

    it("returns 404 when team config not found", async () => {
      const handler = handlers.get("/api/team-detail/")
      const { req, res, next } = createMockReqRes("GET", "nonexistent")
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("returns empty tasks and inboxes when dirs do not exist", async () => {
      const handler = handlers.get("/api/team-detail/")
      const { req, res, next } = createMockReqRes("GET", "my-team")
      mockedIsWithinDir.mockReturnValueOnce(true)

      // config succeeds
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        name: "my-team", members: [],
      }) as unknown as Buffer)

      // tasks dir fails
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))
      // inboxes dir fails
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.tasks).toEqual([])
      expect(response.inboxes).toEqual({})
    })

    it("excludes deleted tasks", async () => {
      const handler = handlers.get("/api/team-detail/")
      const { req, res, next } = createMockReqRes("GET", "my-team")
      mockedIsWithinDir.mockReturnValueOnce(true)

      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ name: "my-team" }) as unknown as Buffer)
      mockedReaddir.mockResolvedValueOnce(["1.json", "2.json"] as unknown as Dirent[])
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ id: "1", status: "deleted" }) as unknown as Buffer)
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ id: "2", status: "pending" }) as unknown as Buffer)
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT")) // no inboxes

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.tasks).toHaveLength(1)
      expect(response.tasks[0].id).toBe("2")
    })
  })

  // ── GET /api/team-watch/:teamName (SSE) ───────────────────────────────

  describe("GET /api/team-watch/:teamName", () => {
    it("calls next for non-GET methods", () => {
      const handler = handlers.get("/api/team-watch/")
      const { req, res, next } = createMockReqRes("POST", "my-team")
      handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 403 for paths outside TEAMS_DIR", () => {
      const handler = handlers.get("/api/team-watch/")
      const { req, res, next } = createMockReqRes("GET", "../../etc")
      mockedIsWithinDir.mockReturnValueOnce(false)

      handler(req, res, next)

      expect(res._getStatus()).toBe(403)
    })

    it("sets SSE headers and sends init event", () => {
      const handler = handlers.get("/api/team-watch/")
      const { req, res, next } = createMockReqRes("GET", "my-team")
      mockedIsWithinDir.mockReturnValueOnce(true)

      const mockWatcher = { on: vi.fn(), close: vi.fn() }
      mockedWatch.mockReturnValue(mockWatcher as unknown as FSWatcher)

      handler(req, res, next)

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      expect(res.write).toHaveBeenCalledWith(
        `data: ${JSON.stringify({ type: "init" })}\n\n`
      )
    })
  })

  // ── POST /api/team-message/:teamName/:memberName ──────────────────────

  describe("POST /api/team-message/:teamName/:memberName", () => {
    it("calls next for non-POST methods", () => {
      const handler = handlers.get("/api/team-message/")
      const { req, res, next } = createMockReqRes("GET", "team/member")
      handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("calls next when path parts != 2", () => {
      const handler = handlers.get("/api/team-message/")
      const { req, res, next } = createMockReqRes("POST", "team-only")
      handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 403 for paths outside TEAMS_DIR", () => {
      const handler = handlers.get("/api/team-message/")
      const { req, res, next } = createMockReqRes("POST", "../../etc/member")
      mockedIsWithinDir.mockReturnValueOnce(false)

      handler(req, res, next)

      expect(res._getStatus()).toBe(403)
    })

    it("appends message to inbox file", async () => {
      const handler = handlers.get("/api/team-message/")
      const body = JSON.stringify({ message: "hello team" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "my-team/worker", body)
      mockedIsWithinDir.mockReturnValueOnce(true)

      // Existing inbox
      mockedReadFile.mockResolvedValueOnce(JSON.stringify([
        { from: "lead", text: "welcome" },
      ]) as unknown as Buffer)
      mockedWriteFile.mockResolvedValueOnce(undefined)

      handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.success).toBe(true)
      expect(mockedWriteFile).toHaveBeenCalled()
    })

    it("creates new inbox when file does not exist", async () => {
      const handler = handlers.get("/api/team-message/")
      const body = JSON.stringify({ message: "first message" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "my-team/worker", body)
      mockedIsWithinDir.mockReturnValueOnce(true)

      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))
      mockedWriteFile.mockResolvedValueOnce(undefined)

      handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res.end).toHaveBeenCalled()
      })
      const response = JSON.parse(res._getData())
      expect(response.success).toBe(true)
    })

    it("returns 400 when message is missing", async () => {
      const handler = handlers.get("/api/team-message/")
      const body = JSON.stringify({ notMessage: "oops" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "my-team/worker", body)
      mockedIsWithinDir.mockReturnValueOnce(true)

      handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })

    it("returns 400 for invalid JSON body", async () => {
      const handler = handlers.get("/api/team-message/")
      const { req, res, next, sendBody } = createMockReqRes("POST", "my-team/worker", "not-json{")
      mockedIsWithinDir.mockReturnValueOnce(true)

      handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })
  })
})
