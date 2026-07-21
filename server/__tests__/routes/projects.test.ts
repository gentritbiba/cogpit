// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Stats, Dirent } from "node:fs"

const mockGetActiveCodexTurnId = vi.hoisted(() => vi.fn())
const mockGetCodexSessionInventory = vi.hoisted(() => vi.fn())

vi.mock("../../helpers", () => ({
  dirs: {
    PROJECTS_DIR: "/tmp/test-projects",
  },
  CODEX_SESSIONS_DIR: "/tmp/codex-sessions",
  decodeCodexDirName: vi.fn(() => null),
  encodeCodexDirName: vi.fn((cwd: string) => `codex__${cwd}`),
  findJsonlPath: vi.fn(),
  isCodexDirName: vi.fn((dirName: string) => dirName.startsWith("codex__")),
  isWithinDir: vi.fn(),
  projectDirToReadableName: vi.fn(),
  getSessionMeta: vi.fn(),
  getSessionStatus: vi.fn().mockResolvedValue({ status: "idle" }),
  listCodexSessionFiles: vi.fn().mockResolvedValue([]),
  readdir: vi.fn(),
  readFile: vi.fn(),
  resolveSessionFilePath: vi.fn((dirName: string, fileName: string) => `/tmp/test-projects/${dirName}/${fileName}`),
  stat: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

vi.mock("../../codex-app-server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../codex-app-server")>()
  return {
    ...actual,
    codexAppServer: { getActiveTurnId: mockGetActiveCodexTurnId },
  }
})

vi.mock("../../lib/codexSessionInventory", () => ({
  getCodexSessionInventory: mockGetCodexSessionInventory,
}))

import {
  findJsonlPath,
  isWithinDir,
  projectDirToReadableName,
  getSessionMeta,
  getSessionStatus,
  listCodexSessionFiles,
  readdir,
  readFile,
  resolveSessionFilePath,
  stat,
} from "../../helpers"

const mockedFindJsonlPath = vi.mocked(findJsonlPath)
const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedProjectDirToReadableName = vi.mocked(projectDirToReadableName)
const mockedGetSessionMeta = vi.mocked(getSessionMeta)
const mockedGetSessionStatus = vi.mocked(getSessionStatus)
const mockedListCodexSessionFiles = vi.mocked(listCodexSessionFiles)
const mockedReaddir = asReaddirMock(vi.mocked(readdir))
const mockedReadFile = vi.mocked(readFile)
const mockedResolveSessionFilePath = vi.mocked(resolveSessionFilePath)
const mockedStat = vi.mocked(stat)

import type { UseFn, Middleware } from "../../helpers"
import {
  asIncomingMessage,
  asReaddirMock,
  asServerResponse,
  getRouteHandler,
  makeSessionMeta,
} from "../http-fixtures"
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
  return { req: asIncomingMessage(req), res: asServerResponse(res), next }
}

describe("project routes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.resetAllMocks()
    // getSessionStatus always returns idle by default
    mockedGetSessionStatus.mockResolvedValue({ status: "idle" as const })
    mockedListCodexSessionFiles.mockResolvedValue([])
    mockGetCodexSessionInventory.mockResolvedValue([])
    mockedResolveSessionFilePath.mockImplementation(async (dirName: string, fileName: string) => `/tmp/test-projects/${dirName}/${fileName}`)
    mockedFindJsonlPath.mockResolvedValue(null)
    mockGetActiveCodexTurnId.mockReturnValue(undefined)
    handlers = new Map()
    const use: UseFn = (path: string, handler: Middleware) => {
      handlers.set(path, handler)
    }
    registerProjectRoutes(use)
  })

  // ── GET /api/projects ─────────────────────────────────────────────────

  describe("GET /api/projects", () => {
    it("calls next for non-GET methods", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("POST", "/")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("calls next for non-root URL paths", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/something")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns project list sorted by last modified", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
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
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockResolvedValueOnce([
        { name: "file.txt", isDirectory: () => false },
      ] as unknown as Dirent[])

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })

    it("skips projects with no jsonl files", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockResolvedValueOnce([
        { name: "empty-proj", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReaddir.mockResolvedValueOnce(["readme.md", "config.json"] as unknown as Dirent[])

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })

    it("returns Codex projects when the Claude projects directory is missing", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedReaddir.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      mockGetCodexSessionInventory.mockResolvedValueOnce([{
        fileName: "rollout-codex-1.jsonl",
        filePath: "/tmp/codex-sessions/rollout-codex-1.jsonl",
        mtimeMs: 2000,
        size: 300,
        sessionId: "codex-1",
        cwd: "/code/codex-only",
        gitBranch: "main",
        isSubagent: false,
        parentSessionId: null,
      }])

      await handler(req, res, next)

      expect(res._getStatus()).toBe(200)
      expect(JSON.parse(res._getData())).toEqual([
        expect.objectContaining({
          dirName: "codex__/code/codex-only",
          path: "/code/codex-only",
          shortName: "codex-only (Codex)",
          sessionCount: 1,
        }),
      ])
    })

    it("returns 500 on non-missing-directory readdir errors", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("handles empty URL as root path", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("GET", "")

      mockedReaddir.mockResolvedValueOnce([] as unknown as Dirent[])

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })
  })

  describe("GET /api/codex-subagents", () => {
    it("returns Codex subagents with read-only virtual paths", async () => {
      const handler = getRouteHandler(handlers, "/api/codex-subagents")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedListCodexSessionFiles.mockResolvedValueOnce([
        {
          fileName: "2026/07/14/rollout-sub-older.jsonl",
          filePath: "/tmp/codex-sessions/2026/07/14/rollout-sub-older.jsonl",
          mtimeMs: 1_000,
          size: 200,
        },
        {
          fileName: "2026/07/15/rollout-parent.jsonl",
          filePath: "/tmp/codex-sessions/2026/07/15/rollout-parent.jsonl",
          mtimeMs: 3_000,
          size: 400,
        },
      ])
      mockedGetSessionMeta
        .mockResolvedValueOnce(makeSessionMeta({
          sessionId: "sub-older", version: "", gitBranch: "main", model: "gpt-5",
          slug: "", cwd: "/code/cogpit", firstUserMessage: "Inspect the API", lastUserMessage: "Inspect the API",
          timestamp: "", lastTimestamp: "", turnCount: 1, lineCount: 4,
          isSubagent: true, parentSessionId: "parent-1", agentPath: "/root/api_scout",
        }))
        .mockResolvedValueOnce(makeSessionMeta({
          sessionId: "parent", version: "", gitBranch: "main", model: "gpt-5",
          slug: "", cwd: "/code/cogpit", firstUserMessage: "Build it", lastUserMessage: "Build it",
          timestamp: "", lastTimestamp: "", turnCount: 2, lineCount: 8,
          isSubagent: false, parentSessionId: null, agentPath: "/root",
        }))

      await handler(req, res, next)

      expect(JSON.parse(res._getData())).toEqual([
        expect.objectContaining({
          sessionId: "sub-older",
          dirName: "codex__/code/cogpit",
          fileName: "parent-1/subagents/agent-sub-older.jsonl",
          parentSessionId: "parent-1",
        }),
      ])
    })
  })

  // ── GET /api/sessions/:dirName ────────────────────────────────────────

  describe("GET /api/sessions/:dirName (list sessions)", () => {
    it("calls next for non-GET methods", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("POST", "proj-a")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns 403 for paths outside PROJECTS_DIR", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "../../etc")
      mockedIsWithinDir.mockReturnValueOnce(false)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(403)
    })

    it("lists sessions with pagination", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a?page=1&limit=10")
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReaddir.mockResolvedValueOnce(["s1.jsonl", "s2.jsonl", "readme.md"] as unknown as Dirent[])
      mockedStat.mockResolvedValueOnce({ mtime: new Date(2000), size: 100 } as unknown as Stats)
      mockedStat.mockResolvedValueOnce({ mtime: new Date(1000), size: 200 } as unknown as Stats)
      mockedGetSessionMeta.mockResolvedValueOnce(makeSessionMeta({
        sessionId: "s1", version: "", gitBranch: "", model: "", slug: "",
        cwd: "", firstUserMessage: "", lastUserMessage: "", timestamp: "",
        turnCount: 5, lineCount: 10,
      }))
      mockedGetSessionMeta.mockResolvedValueOnce(makeSessionMeta({
        sessionId: "s2", version: "", gitBranch: "", model: "", slug: "",
        cwd: "", firstUserMessage: "", lastUserMessage: "", timestamp: "",
        turnCount: 3, lineCount: 6,
      }))

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.sessions).toHaveLength(2)
      expect(response.total).toBe(2)
      expect(response.page).toBe(1)
      // Most recent first (s1 has mtime 2000)
      expect(response.sessions[0].sessionId).toBe("s1")
    })

    it("returns 500 on readdir error", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a")
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReaddir.mockRejectedValueOnce(new Error("EPERM"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("falls back gracefully when getSessionMeta fails", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
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
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a/file.txt")

      await handler(req, res, next)

      expect(res._getStatus()).toBe(400)
    })

    it("returns 403 for paths outside PROJECTS_DIR", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "../../etc/session.jsonl")
      mockedResolveSessionFilePath.mockResolvedValueOnce(null)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(403)
    })

    it("serves .jsonl file content", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a/session.jsonl")
      mockedIsWithinDir.mockReturnValueOnce(true)
      mockedReadFile.mockResolvedValueOnce('{"line":1}\n{"line":2}\n' as unknown as Buffer)

      await handler(req, res, next)

      expect(res._getData()).toBe('{"line":1}\n{"line":2}\n')
      expect(res._getHeaders()["Content-Type"]).toBe("text/plain")
    })

    it("resolves a virtual Codex subagent path to its flat rollout file", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes(
        "GET",
        "codex__project/parent-1/subagents/agent-sub-1.jsonl"
      )
      mockedFindJsonlPath.mockResolvedValueOnce("/tmp/codex-sessions/2026/07/15/rollout-sub-1.jsonl")
      mockedReadFile.mockResolvedValueOnce('{"type":"session_meta"}\n' as unknown as Buffer)

      await handler(req, res, next)

      expect(mockedFindJsonlPath).toHaveBeenCalledWith("sub-1")
      expect(mockedReadFile).toHaveBeenCalledWith(
        "/tmp/codex-sessions/2026/07/15/rollout-sub-1.jsonl",
        "utf-8"
      )
      expect(res._getStatus()).toBe(200)
    })

    it("returns 404 when file not found", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
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
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("POST", "/")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("returns active sessions sorted by mtime", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "?limit=10")

      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReaddir.mockResolvedValueOnce(["s1.jsonl"] as unknown as Dirent[])
      mockedStat.mockResolvedValueOnce({ mtimeMs: Date.now(), size: 500 } as unknown as Stats)
      mockedGetSessionMeta.mockResolvedValueOnce(makeSessionMeta({
        sessionId: "s1", version: "", gitBranch: "main", model: "claude",
        slug: "", cwd: "/code", firstUserMessage: "hello", lastUserMessage: "bye",
        timestamp: "", turnCount: 3, lineCount: 10,
      }))
      mockedProjectDirToReadableName.mockReturnValueOnce({ path: "/proj/a", shortName: "a" })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toHaveLength(1)
      expect(response[0].sessionId).toBe("s1")
      expect(response[0].isActive).toBe(false)
      expect(response[0].projectShortName).toBe("a")
    })

    it("sorts active sessions by displayed activity time when it differs from file mtime", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "?limit=10")

      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReaddir.mockResolvedValueOnce([
        "mtime-newer.jsonl",
        "activity-newer.jsonl",
      ] as unknown as Dirent[])

      mockedStat.mockResolvedValueOnce({ mtimeMs: Date.parse("2026-03-21T12:00:00.000Z"), size: 200 } as unknown as Stats)
      mockedStat.mockResolvedValueOnce({ mtimeMs: Date.parse("2026-03-21T11:00:00.000Z"), size: 200 } as unknown as Stats)

      mockedGetSessionMeta
        .mockResolvedValueOnce(makeSessionMeta({
          sessionId: "mtime-newer",
          version: "",
          gitBranch: "main",
          model: "claude",
          slug: "",
          cwd: "/code",
          firstUserMessage: "older visible activity",
          lastUserMessage: "older visible activity",
          timestamp: "",
          lastTimestamp: "2026-03-20T12:00:00.000Z",
          turnCount: 3,
          lineCount: 10,
        }))
        .mockResolvedValueOnce(makeSessionMeta({
          sessionId: "activity-newer",
          version: "",
          gitBranch: "main",
          model: "claude",
          slug: "",
          cwd: "/code",
          firstUserMessage: "newer visible activity",
          lastUserMessage: "newer visible activity",
          timestamp: "",
          lastTimestamp: "2026-03-21T11:30:00.000Z",
          turnCount: 4,
          lineCount: 12,
        }))

      mockedProjectDirToReadableName.mockReturnValue({ path: "/proj/a", shortName: "a" })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toHaveLength(2)
      expect(response[0].sessionId).toBe("activity-newer")
      expect(response[1].sessionId).toBe("mtime-newer")
    })

    it("skips memory directory", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockResolvedValueOnce([
        { name: "memory", isDirectory: () => true },
      ] as unknown as Dirent[])

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response).toEqual([])
    })

    it("returns Codex sessions when the Claude projects directory is missing", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")
      mockedReaddir.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      mockGetCodexSessionInventory.mockResolvedValueOnce([{
        fileName: "rollout-codex-active.jsonl",
        filePath: "/tmp/codex-sessions/rollout-codex-active.jsonl",
        mtimeMs: Date.now(),
        size: 400,
        sessionId: "codex-active",
        cwd: "/code/codex-only",
        gitBranch: "main",
        isSubagent: false,
        parentSessionId: null,
      }])
      mockedGetSessionMeta.mockResolvedValue(makeSessionMeta({
        sessionId: "codex-active", version: "", gitBranch: "main", model: "gpt-5.6-terra",
        slug: "", cwd: "/code/codex-only", firstUserMessage: "hello", lastUserMessage: "bye",
        timestamp: "", turnCount: 2, lineCount: 4,
      }))
      mockGetActiveCodexTurnId.mockReturnValue("turn-codex-active")

      await handler(req, res, next)

      expect(res._getStatus()).toBe(200)
      expect(JSON.parse(res._getData())).toEqual([
        expect.objectContaining({
          sessionId: "codex-active",
          projectShortName: "codex-only (Codex)",
          isActive: true,
        }),
      ])
    })

    it("returns 500 on non-missing-directory top-level errors", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")

      mockedReaddir.mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
      const response = JSON.parse(res._getData())
      expect(response.code).toBe("INTERNAL_ERROR")
    })

    it("marks old sessions as not active", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")

      const oldTime = Date.now() - 10 * 60 * 1000 // 10 minutes ago
      mockedReaddir.mockResolvedValueOnce([
        { name: "proj-a", isDirectory: () => true },
      ] as unknown as Dirent[])
      mockedReaddir.mockResolvedValueOnce(["old.jsonl"] as unknown as Dirent[])
      mockedStat.mockResolvedValueOnce({ mtimeMs: oldTime, size: 100 } as unknown as Stats)
      mockedGetSessionMeta.mockResolvedValueOnce(makeSessionMeta({
        sessionId: "old", version: "", gitBranch: "", model: "",
        slug: "", cwd: "", firstUserMessage: "", lastUserMessage: "",
        timestamp: "", turnCount: 1, lineCount: 2,
      }))
      mockedProjectDirToReadableName.mockReturnValueOnce({ path: "/proj/a", shortName: "a" })

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response[0].isActive).toBe(false)
    })
  })

  // ── GET /api/find-session/:sessionId ──────────────────────────────────

  describe("GET /api/find-session/:sessionId", () => {
    it("calls next for non-GET methods", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("POST", "abc-123")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })

    it("finds session by ID across projects", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc-123")
      mockedFindJsonlPath.mockResolvedValueOnce("/tmp/test-projects/proj-b/abc-123.jsonl")

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.dirName).toBe("proj-b")
      expect(response.fileName).toBe("abc-123.jsonl")
    })

    it("returns 404 when session not found", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "nonexistent")
      mockedFindJsonlPath.mockResolvedValueOnce(null)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("returns 500 on readdir error", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc-123")
      mockedFindJsonlPath.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("skips memory directory", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc-123")
      mockedFindJsonlPath.mockResolvedValueOnce(null)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("calls next when URL has multiple path segments", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc/extra")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })
  })
})
