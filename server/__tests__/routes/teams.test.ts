// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Dirent, FSWatcher } from "node:fs"

vi.mock("../../helpers", () => ({
  dirs: {
    TEAMS_DIR: "/tmp/test-teams",
    TASKS_DIR: "/tmp/test-tasks",
  },
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
  watch: vi.fn(),
}))

import {
  readdir,
  readFile,
  writeFile,
  watch,
} from "../../helpers"

const mockedReaddir = asReaddirMock(vi.mocked(readdir))
const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFile)
const mockedWatch = vi.mocked(watch)

import type { Middleware } from "../../helpers"
import { asReaddirMock, collectRoutes, createMockReqRes, getRouteHandler } from "../http-fixtures"
import { registerTeamRoutes } from "../../routes/teams"

describe("team routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.resetAllMocks()
    handlers = collectRoutes(registerTeamRoutes)
  })

  // ── GET /api/teams ────────────────────────────────────────────────────

  describe("GET /api/teams", () => {
    it("calls next for non-GET methods", async () => {
      const handler = getRouteHandler(handlers, "/api/teams")
      const { req, res, next } = createMockReqRes("POST", "/")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("calls next for sub-paths", async () => {
      const handler = getRouteHandler(handlers, "/api/teams")
      const { req, res, next } = createMockReqRes("GET", "/something")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns empty array when TEAMS_DIR does not exist", async () => {
      const handler = getRouteHandler(handlers, "/api/teams")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })

    it("lists teams with task summaries sorted by createdAt", async () => {
      const handler = getRouteHandler(handlers, "/api/teams")
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
      const handler = getRouteHandler(handlers, "/api/teams")
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
      const handler = getRouteHandler(handlers, "/api/teams")
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
      const handler = getRouteHandler(handlers, "/api/team-detail/")
      const { req, res, next } = createMockReqRes("POST", "my-team")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("refuses a team name that is not one path segment", async () => {
      const handler = getRouteHandler(handlers, "/api/team-detail/")
      const { req, res, next } = createMockReqRes("GET", "..%2F..%2Fetc")

      await handler(req, res, next)

      expect(res._getStatus()).toBe(400)
      expect(mockedReadFile).not.toHaveBeenCalled()
    })

    it("returns full team detail with config, tasks, and inboxes", async () => {
      const handler = getRouteHandler(handlers, "/api/team-detail/")
      const { req, res, next } = createMockReqRes("GET", "my-team")

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
      const handler = getRouteHandler(handlers, "/api/team-detail/")
      const { req, res, next } = createMockReqRes("GET", "nonexistent")
      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("returns empty tasks and inboxes when dirs do not exist", async () => {
      const handler = getRouteHandler(handlers, "/api/team-detail/")
      const { req, res, next } = createMockReqRes("GET", "my-team")

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
      const handler = getRouteHandler(handlers, "/api/team-detail/")
      const { req, res, next } = createMockReqRes("GET", "my-team")

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
      const handler = getRouteHandler(handlers, "/api/team-watch/")
      const { req, res, next } = createMockReqRes("POST", "my-team")
      handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("refuses a team name that is not one path segment", async () => {
      const handler = getRouteHandler(handlers, "/api/team-watch/")
      const { req, res, next } = createMockReqRes("GET", "..%2F..%2Fetc")

      await handler(req, res, next)

      expect(res._getStatus()).toBe(400)
      expect(mockedWatch).not.toHaveBeenCalled()
    })

    it("sets SSE headers and sends init event", async () => {
      const handler = getRouteHandler(handlers, "/api/team-watch/")
      const { req, res, next } = createMockReqRes("GET", "my-team")

      const mockWatcher = { on: vi.fn(), close: vi.fn() }
      mockedWatch.mockReturnValue(mockWatcher as unknown as FSWatcher)

      await handler(req, res, next)

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      expect(res.write).toHaveBeenCalledWith(
        `data: ${JSON.stringify({ type: "init" })}\n\n`
      )
      expect(mockedReadFile).not.toHaveBeenCalled()
    })

    it("opens nothing for a caller who went away while access was checked", async () => {
      const handler = getRouteHandler(handlers, "/api/team-watch/")
      const { req, res, next } = createMockReqRes("GET", "my-team")
      Object.assign(res, { destroyed: true })

      await handler(req, res, next)

      expect(res.writeHead).not.toHaveBeenCalled()
      expect(mockedWatch).not.toHaveBeenCalled()
    })
  })

  // ── POST /api/team-message/:teamName/:memberName ──────────────────────

  describe("POST /api/team-message/:teamName/:memberName", () => {
    it("calls next for non-POST methods", () => {
      const handler = getRouteHandler(handlers, "/api/team-message/")
      const { req, res, next } = createMockReqRes("GET", "team/member")
      handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("calls next when path parts != 2", () => {
      const handler = getRouteHandler(handlers, "/api/team-message/")
      const { req, res, next } = createMockReqRes("POST", "team-only")
      handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it.each(["..%2F..%2Fetc/member", "my-team/..%2F..%2Fother%2Finboxes%2Fworker", "my-team/..%5Cother"])(
      "refuses %s, whose names are not one path segment each",
      async (path) => {
        const handler = getRouteHandler(handlers, "/api/team-message/")
        const { req, res, next } = createMockReqRes("POST", path)

        await handler(req, res, next)

        expect(res._getStatus()).toBe(400)
        expect(mockedWriteFile).not.toHaveBeenCalled()
      },
    )

    it("appends message to inbox file", async () => {
      const handler = getRouteHandler(handlers, "/api/team-message/")
      const body = JSON.stringify({ message: "hello team" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "my-team/worker", { body })

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
      const written = JSON.parse(String(mockedWriteFile.mock.calls[0]?.[1]))
      expect(written.map((entry: { text: string }) => entry.text)).toEqual(["welcome", "hello team"])
    })

    it("creates new inbox when file does not exist", async () => {
      const handler = getRouteHandler(handlers, "/api/team-message/")
      const body = JSON.stringify({ message: "first message" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "my-team/worker", { body })

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
      const handler = getRouteHandler(handlers, "/api/team-message/")
      const body = JSON.stringify({ notMessage: "oops" })
      const { req, res, next, sendBody } = createMockReqRes("POST", "my-team/worker", { body })

      handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })

    it("returns 400 for invalid JSON body", async () => {
      const handler = getRouteHandler(handlers, "/api/team-message/")
      const { req, res, next, sendBody } = createMockReqRes("POST", "my-team/worker", { body: "not-json{" })

      handler(req, res, next)
      sendBody()

      await vi.waitFor(() => {
        expect(res._getStatus()).toBe(400)
      })
    })
  })
})
