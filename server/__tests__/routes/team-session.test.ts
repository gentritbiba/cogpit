// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Dirent } from "node:fs"
import type { FileHandle } from "node:fs/promises"

vi.mock("../../helpers", () => ({
  dirs: {
    TEAMS_DIR: "/tmp/test-teams",
    PROJECTS_DIR: "/tmp/test-projects",
  },
  matchSubagentToMember: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  open: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

import {
  matchSubagentToMember,
  readdir,
  readFile,
  open,
} from "../../helpers"

const mockedMatchSubagent = vi.mocked(matchSubagentToMember)
const mockedReaddir = vi.mocked(readdir)
const mockedReadFile = vi.mocked(readFile)
const mockedOpen = vi.mocked(open)

import type { UseFn, Middleware } from "../../helpers"
import { registerTeamSessionRoutes } from "../../routes/team-session"

function createMockReqRes(method: string, url: string) {
  let endData = ""
  let statusCode = 200
  const headers: Record<string, string> = {}
  const req = {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  }
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn((name: string, value: string) => { headers[name] = value }),
    end: vi.fn((data?: string) => { endData = data || "" }),
    _getData: () => endData,
    _getStatus: () => statusCode,
  }
  const next = vi.fn()
  return { req, res, next }
}

describe("team-session routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.resetAllMocks()
    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => {
      handlers.set(path, handler)
    }
    registerTeamSessionRoutes(use)
  })

  // ── GET /api/session-team ─────────────────────────────────────────────

  describe("GET /api/session-team", () => {
    it("calls next for non-GET methods", async () => {
      const handler = handlers.get("/api/session-team")
      const { req, res, next } = createMockReqRes("POST", "/")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("calls next for sub-paths", async () => {
      const handler = handlers.get("/api/session-team")
      const { req, res, next } = createMockReqRes("GET", "/something")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 400 when leadSessionId is missing", async () => {
      const handler = handlers.get("/api/session-team")
      const { req, res, next } = createMockReqRes("GET", "?other=value")
      await handler(req, res, next)
      expect(res._getStatus()).toBe(400)
    })

    it("returns 404 when TEAMS_DIR does not exist", async () => {
      const handler = handlers.get("/api/session-team")
      const { req, res, next } = createMockReqRes("GET", "?leadSessionId=abc-123")
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("returns 404 when no team matches the leadSessionId", async () => {
      const handler = handlers.get("/api/session-team")
      const { req, res, next } = createMockReqRes("GET", "?leadSessionId=abc-123")

      mockedReaddir.mockResolvedValueOnce([
        { name: "team-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        leadSessionId: "different-session",
        members: [],
      }) as unknown as Buffer)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("returns team config with lead as currentMemberName when no subagentFile", async () => {
      const handler = handlers.get("/api/session-team")
      const { req, res, next } = createMockReqRes("GET", "?leadSessionId=abc-123")

      mockedReaddir.mockResolvedValueOnce([
        { name: "my-team", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        leadSessionId: "abc-123",
        createdAt: 1000,
        members: [
          { name: "boss", agentType: "team-lead" },
          { name: "worker", agentType: "agent" },
        ],
      }) as unknown as Buffer)

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.teamName).toBe("my-team")
      expect(response.currentMemberName).toBe("boss")
    })

    it("uses matchSubagentToMember when subagentFile is provided", async () => {
      const handler = handlers.get("/api/session-team")
      const { req, res, next } = createMockReqRes(
        "GET", "?leadSessionId=abc-123&subagentFile=agent-xyz.jsonl"
      )

      const members = [
        { name: "boss", agentType: "team-lead" },
        { name: "worker", agentType: "agent" },
      ]

      mockedReaddir.mockResolvedValueOnce([
        { name: "my-team", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        leadSessionId: "abc-123",
        createdAt: 1000,
        members,
      }) as unknown as Buffer)
      mockedMatchSubagent.mockResolvedValueOnce("worker")

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.currentMemberName).toBe("worker")
      expect(mockedMatchSubagent).toHaveBeenCalledWith(
        "abc-123", "agent-xyz.jsonl", members
      )
    })

    it("picks the most recently created team when multiple match", async () => {
      const handler = handlers.get("/api/session-team")
      const { req, res, next } = createMockReqRes("GET", "?leadSessionId=abc-123")

      mockedReaddir.mockResolvedValueOnce([
        { name: "old-team", isDirectory: () => true },
        { name: "new-team", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        leadSessionId: "abc-123",
        createdAt: 1000,
        members: [{ name: "old-lead", agentType: "team-lead" }],
      }) as unknown as Buffer)
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        leadSessionId: "abc-123",
        createdAt: 2000,
        members: [{ name: "new-lead", agentType: "team-lead" }],
      }) as unknown as Buffer)

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.teamName).toBe("new-team")
      expect(response.currentMemberName).toBe("new-lead")
    })
  })

  // ── GET /api/team-member-session/:teamName/:memberName ────────────────

  describe("GET /api/team-member-session/:teamName/:memberName", () => {
    it("calls next for non-GET methods", async () => {
      const handler = handlers.get("/api/team-member-session/")
      const { req, res, next } = createMockReqRes("POST", "team/member")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("calls next when path parts != 2", async () => {
      const handler = handlers.get("/api/team-member-session/")
      const { req, res, next } = createMockReqRes("GET", "team-only")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 404 when team has no leadSessionId", async () => {
      const handler = handlers.get("/api/team-member-session/")
      const { req, res, next } = createMockReqRes("GET", "my-team/worker")
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        members: [{ name: "worker", agentType: "agent" }],
      }) as unknown as Buffer)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("finds lead session file directly for team-lead members", async () => {
      const handler = handlers.get("/api/team-member-session/")
      const { req, res, next } = createMockReqRes("GET", "my-team/boss")

      // config
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        leadSessionId: "lead-sess-123",
        members: [{ name: "boss", agentType: "team-lead" }],
      }) as unknown as Buffer)

      // readdir PROJECTS_DIR
      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      // readdir project dir
      mockedReaddir.mockResolvedValueOnce(["lead-sess-123.jsonl", "other.jsonl"] as unknown as Dirent[])

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.dirName).toBe("proj-a")
      expect(response.fileName).toBe("lead-sess-123.jsonl")
    })

    it("returns 404 when lead session file not found", async () => {
      const handler = handlers.get("/api/team-member-session/")
      const { req, res, next } = createMockReqRes("GET", "my-team/boss")

      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        leadSessionId: "lead-sess-123",
        members: [{ name: "boss", agentType: "team-lead" }],
      }) as unknown as Buffer)

      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReaddir.mockResolvedValueOnce(["other.jsonl"] as unknown as Dirent[])

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("returns 404 when non-lead member session not found", async () => {
      const handler = handlers.get("/api/team-member-session/")
      const { req, res, next } = createMockReqRes("GET", "my-team/worker")

      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        leadSessionId: "lead-sess-123",
        members: [
          { name: "boss", agentType: "team-lead" },
          { name: "worker", agentType: "agent", prompt: "do work" },
        ],
      }) as unknown as Buffer)

      // readdir PROJECTS_DIR
      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      // subagent dir doesn't exist
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("returns 500 on config read error", async () => {
      const handler = handlers.get("/api/team-member-session/")
      const { req, res, next } = createMockReqRes("GET", "my-team/worker")

      mockedReadFile.mockRejectedValueOnce(new Error("EPERM"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("finds subagent session by matching member name in first line", async () => {
      const handler = handlers.get("/api/team-member-session/")
      const { req, res, next } = createMockReqRes("GET", "my-team/worker")

      mockedReadFile.mockResolvedValueOnce(JSON.stringify({
        leadSessionId: "lead-sess-123",
        members: [
          { name: "boss", agentType: "team-lead" },
          { name: "worker", agentType: "agent", prompt: "do work" },
        ],
      }) as unknown as Buffer)

      // readdir PROJECTS_DIR
      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
      ] as unknown as Dirent[])

      // subagent dir files
      mockedReaddir.mockResolvedValueOnce(["agent-1.jsonl"] as unknown as Dirent[])

      // open and read first line of subagent file
      const firstLineContent = `{"type":"user","message":{"content":"worker do work"}}`
      const buf = Buffer.from(firstLineContent)
      const mockFh = {
        read: vi.fn().mockResolvedValue({ bytesRead: buf.length }),
        close: vi.fn().mockResolvedValue(undefined),
      }
      mockedOpen.mockResolvedValueOnce(mockFh as unknown as FileHandle)

      // The read call fills the buffer - we need to simulate it
      mockFh.read.mockImplementation(async (buffer: Buffer) => {
        buf.copy(buffer, 0, 0, buf.length)
        return { bytesRead: buf.length }
      })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.dirName).toBe("proj-a")
      expect(response.fileName).toBe("lead-sess-123/subagents/agent-1.jsonl")
    })
  })
})
