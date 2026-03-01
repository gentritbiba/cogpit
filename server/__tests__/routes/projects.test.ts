// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Stats, Dirent } from "node:fs"

vi.mock("../../helpers", () => ({
  dirs: {
    PROJECTS_DIR: "/tmp/test-projects",
  },
  isWithinDir: vi.fn(),
  projectDirToReadableName: vi.fn(),
  getSessionMeta: vi.fn(),
  getSessionStatus: vi.fn().mockResolvedValue({ status: "idle" }),
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

import {
  isWithinDir,
  projectDirToReadableName,
  getSessionMeta,
  getSessionStatus,
  readdir,
  readFile,
  stat,
} from "../../helpers"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedProjectDirToReadableName = vi.mocked(projectDirToReadableName)
const mockedGetSessionMeta = vi.mocked(getSessionMeta)
const mockedGetSessionStatus = vi.mocked(getSessionStatus)
const mockedReaddir = vi.mocked(readdir)
const mockedReadFile = vi.mocked(readFile)
const mockedStat = vi.mocked(stat)

import type { UseFn, Middleware } from "../../helpers"
import { registerProjectRoutes } from "../../routes/projects"

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
    _getHeaders: () => headers,
  }
  const next = vi.fn()
  return { req, res, next }
}

describe("project routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.resetAllMocks()
    // getSessionStatus always returns idle by default
    mockedGetSessionStatus.mockResolvedValue({ status: "idle" as const })
    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => {
      handlers.set(path, handler)
    }
    registerProjectRoutes(use)
  })

  // ── GET /api/projects ─────────────────────────────────────────────────

  describe("GET /api/projects", () => {
    it("calls next for non-GET methods", async () => {
      const handler = handlers.get("/api/projects")
      const { req, res, next } = createMockReqRes("POST", "/")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("calls next for non-root URL paths", async () => {
      const handler = handlers.get("/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/something")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns project list sorted by last modified", async () => {
      const handler = handlers.get("/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
        { name: "proj-b", isDirectory: () => true },
        { name: "memory", isDirectory: () => true },
      ] as unknown as Dirent[])

      // proj-a files
      mockedReaddir.mockResolvedValueOnce(["session1.jsonl", "readme.md"] as unknown as Dirent[])
      mockedStat.mockResolvedValueOnce({ mtimeMs: 1000 } as unknown as Stats)

      // proj-b files
      mockedReaddir.mockResolvedValueOnce(["session2.jsonl"] as unknown as Dirent[])
      mockedStat.mockResolvedValueOnce({ mtimeMs: 2000 } as unknown as Stats)

      mockedProjectDirToReadableName.mockReturnValueOnce({ path: "/proj/a", shortName: "a" })
      mockedProjectDirToReadableName.mockReturnValueOnce({ path: "/proj/b", shortName: "b" })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toHaveLength(2)
      // proj-b is more recent, should be first
      expect(response[0].shortName).toBe("b")
      expect(response[1].shortName).toBe("a")
    })

    it("skips non-directory entries", async () => {
      const handler = handlers.get("/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockResolvedValueOnce([
        { name: "file.txt", isDirectory: () => false },
      ] as unknown as Dirent[])

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })

    it("skips projects with no jsonl files", async () => {
      const handler = handlers.get("/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockResolvedValueOnce([
        { name: "empty-proj", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReaddir.mockResolvedValueOnce(["readme.md", "config.json"] as unknown as Dirent[])

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })

    it("returns 500 on readdir error", async () => {
      const handler = handlers.get("/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("handles empty URL as root path", async () => {
      const handler = handlers.get("/api/projects")
      const { req, res, next } = createMockReqRes("GET", "")

      mockedReaddir.mockResolvedValueOnce([] as unknown as Dirent[])

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })
  })

  // ── GET /api/sessions/:dirName ────────────────────────────────────────

  describe("GET /api/sessions/:dirName (list sessions)", () => {
    it("calls next for non-GET methods", async () => {
      const handler = handlers.get("/api/sessions/")
      const { req, res, next } = createMockReqRes("POST", "proj-a")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 403 for paths outside PROJECTS_DIR", async () => {
      const handler = handlers.get("/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "../../etc")
      mockedIsWithinDir.mockReturnValueOnce(false)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(403)
    })

    it("lists sessions with pagination", async () => {
      const handler = handlers.get("/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a?page=1&limit=10")
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReaddir.mockResolvedValueOnce(["s1.jsonl", "s2.jsonl", "readme.md"] as unknown as Dirent[])
      mockedStat.mockResolvedValueOnce({ mtime: new Date(2000), size: 100 } as unknown as Stats)
      mockedStat.mockResolvedValueOnce({ mtime: new Date(1000), size: 200 } as unknown as Stats)
      mockedGetSessionMeta.mockResolvedValueOnce({
        sessionId: "s1", version: "", gitBranch: "", model: "", slug: "",
        cwd: "", firstUserMessage: "", lastUserMessage: "", timestamp: "",
        turnCount: 5, lineCount: 10,
      })
      mockedGetSessionMeta.mockResolvedValueOnce({
        sessionId: "s2", version: "", gitBranch: "", model: "", slug: "",
        cwd: "", firstUserMessage: "", lastUserMessage: "", timestamp: "",
        turnCount: 3, lineCount: 6,
      })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.sessions).toHaveLength(2)
      expect(response.total).toBe(2)
      expect(response.page).toBe(1)
      // Most recent first (s1 has mtime 2000)
      expect(response.sessions[0].sessionId).toBe("s1")
    })

    it("returns 500 on readdir error", async () => {
      const handler = handlers.get("/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a")
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReaddir.mockRejectedValueOnce(new Error("EPERM"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("falls back gracefully when getSessionMeta fails", async () => {
      const handler = handlers.get("/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a")
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReaddir.mockResolvedValueOnce(["bad.jsonl"] as unknown as Dirent[])
      mockedStat.mockResolvedValueOnce({ mtime: new Date(1000), size: 50 } as unknown as Stats)
      mockedGetSessionMeta.mockRejectedValueOnce(new Error("parse error"))

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.sessions).toHaveLength(1)
      expect(response.sessions[0].sessionId).toBe("bad")
      expect(response.sessions[0].fileName).toBe("bad.jsonl")
    })
  })

  // ── GET /api/sessions/:dirName/:fileName (serve file) ────────────────

  describe("GET /api/sessions/:dirName/:fileName (serve file)", () => {
    it("rejects non-.jsonl files", async () => {
      const handler = handlers.get("/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a/file.txt")

      await handler(req, res, next)

      expect(res._getStatus()).toBe(400)
    })

    it("returns 403 for paths outside PROJECTS_DIR", async () => {
      const handler = handlers.get("/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "../../etc/session.jsonl")
      mockedIsWithinDir.mockReturnValueOnce(false)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(403)
    })

    it("serves .jsonl file content", async () => {
      const handler = handlers.get("/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a/session.jsonl")
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReadFile.mockResolvedValueOnce('{"line":1}\n{"line":2}\n' as unknown as Buffer)

      await handler(req, res, next)

      expect(res._getData()).toBe('{"line":1}\n{"line":2}\n')
      expect(res._getHeaders()["Content-Type"]).toBe("text/plain")
    })

    it("returns 404 when file not found", async () => {
      const handler = handlers.get("/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a/missing.jsonl")
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })
  })

  // ── GET /api/active-sessions ──────────────────────────────────────────

  describe("GET /api/active-sessions", () => {
    it("calls next for non-GET methods", async () => {
      const handler = handlers.get("/api/active-sessions")
      const { req, res, next } = createMockReqRes("POST", "/")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns active sessions sorted by mtime", async () => {
      const handler = handlers.get("/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "?limit=10")

      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReaddir.mockResolvedValueOnce(["s1.jsonl"] as unknown as Dirent[])
      mockedStat.mockResolvedValueOnce({ mtimeMs: Date.now(), size: 500 } as unknown as Stats)
      mockedGetSessionMeta.mockResolvedValueOnce({
        sessionId: "s1", version: "", gitBranch: "main", model: "claude",
        slug: "", cwd: "/code", firstUserMessage: "hello", lastUserMessage: "bye",
        timestamp: "", turnCount: 3, lineCount: 10,
      })
      mockedProjectDirToReadableName.mockReturnValueOnce({ path: "/proj/a", shortName: "a" })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toHaveLength(1)
      expect(response[0].sessionId).toBe("s1")
      expect(response[0].isActive).toBe(true)
      expect(response[0].projectShortName).toBe("a")
    })

    it("skips memory directory", async () => {
      const handler = handlers.get("/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockResolvedValueOnce([
        { name: "memory", isDirectory: () => true },
      ] as unknown as Dirent[])

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })

    it("returns 500 on top-level error", async () => {
      const handler = handlers.get("/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("marks old sessions as not active", async () => {
      const handler = handlers.get("/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")

      const oldTime = Date.now() - 10 * 60 * 1000 // 10 minutes ago
      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReaddir.mockResolvedValueOnce(["old.jsonl"] as unknown as Dirent[])
      mockedStat.mockResolvedValueOnce({ mtimeMs: oldTime, size: 100 } as unknown as Stats)
      mockedGetSessionMeta.mockResolvedValueOnce({
        sessionId: "old", version: "", gitBranch: "", model: "",
        slug: "", cwd: "", firstUserMessage: "", lastUserMessage: "",
        timestamp: "", turnCount: 1, lineCount: 2,
      })
      mockedProjectDirToReadableName.mockReturnValueOnce({ path: "/proj/a", shortName: "a" })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response[0].isActive).toBe(false)
    })
  })

  // ── GET /api/find-session/:sessionId ──────────────────────────────────

  describe("GET /api/find-session/:sessionId", () => {
    it("calls next for non-GET methods", async () => {
      const handler = handlers.get("/api/find-session/")
      const { req, res, next } = createMockReqRes("POST", "abc-123")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("finds session by ID across projects", async () => {
      const handler = handlers.get("/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc-123")

      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
        { name: "proj-b", isDirectory: () => true },
      ] as unknown as Dirent[])
      // proj-a doesn't have it
      mockedReaddir.mockResolvedValueOnce(["other.jsonl"] as unknown as Dirent[])
      // proj-b has it
      mockedReaddir.mockResolvedValueOnce(["abc-123.jsonl", "other.jsonl"] as unknown as Dirent[])

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.dirName).toBe("proj-b")
      expect(response.fileName).toBe("abc-123.jsonl")
    })

    it("returns 404 when session not found", async () => {
      const handler = handlers.get("/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "nonexistent")

      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReaddir.mockResolvedValueOnce(["other.jsonl"] as unknown as Dirent[])

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("returns 500 on readdir error", async () => {
      const handler = handlers.get("/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc-123")

      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("skips memory directory", async () => {
      const handler = handlers.get("/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc-123")

      mockedReaddir.mockResolvedValueOnce([
        { name: "memory", isDirectory: () => true },
      ] as unknown as Dirent[])

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("calls next when URL has multiple path segments", async () => {
      const handler = handlers.get("/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc/extra")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })
  })
})
