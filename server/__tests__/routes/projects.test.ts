// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * The project routes compose the agent stores; what each store answers about
 * its own layout is pinned in `agents/store-projects.test.ts`. Here every
 * store is a fake, so these tests cover the routes' own work: sorting, paging,
 * status and metadata joins, and how the registries are asked.
 */

const mocks = vi.hoisted(() => {
  const perKind = () => ({
    claude: vi.fn(),
    codex: vi.fn(),
    copilot: vi.fn(),
  }) as Record<string, ReturnType<typeof vi.fn>>
  return {
    listProjects: perKind(),
    listProjectSessionFiles: perKind(),
    listTopLevelSessions: perKind(),
    listSubagentFiles: perKind(),
    sessionAddress: perKind(),
    listSessionFiles: perKind(),
    runtimeRunning: vi.fn(),
    getSessionPrSearchSnapshot: vi.fn(),
  }
})

vi.mock("../../helpers", () => ({
  dirs: {
    PROJECTS_DIR: "/tmp/test-projects",
    TEAMS_DIR: "/tmp/test-teams",
  },
  isWithinDir: vi.fn(),
  getSessionMeta: vi.fn(),
  getSessionStatus: vi.fn().mockResolvedValue({ status: "idle" }),
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  open: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
}))

vi.mock("../../lib/projectNames", () => ({
  projectDirToReadableName: vi.fn(),
  shortNameFromPath: vi.fn((path: string) => path.replace(/\/+$/, "").split("/").at(-1) || path),
}))

vi.mock("../../sessionPaths", () => ({
  findJsonlPath: vi.fn(),
  resolveSessionFilePath: vi.fn(
    (dirName: string, fileName: string) => `/tmp/test-projects/${dirName}/${fileName}`,
  ),
}))

vi.mock("../../agents", async () => {
  const { descriptorFor, descriptorForDirName } = await vi.importActual<
    typeof import("../../../shared/session/agent-descriptors")
  >("../../../shared/session/agent-descriptors")
  const roots: Record<string, string> = {
    claude: "/tmp/test-projects",
    codex: "/tmp/codex-sessions",
    copilot: "/tmp/copilot-sessions",
  }
  const storeFor = (kind: string) => ({
    kind,
    descriptor: descriptorFor(kind as "claude"),
    sessionsRoot: () => roots[kind],
    ownsPath: (filePath: string) => filePath.startsWith(`${roots[kind]}/`),
    listSessionFiles: mocks.listSessionFiles[kind],
    listProjects: mocks.listProjects[kind],
    listProjectSessionFiles: mocks.listProjectSessionFiles[kind],
    listTopLevelSessions: mocks.listTopLevelSessions[kind],
    listSubagentFiles: mocks.listSubagentFiles[kind],
    sessionAddress: mocks.sessionAddress[kind],
  })
  const kinds = ["codex", "copilot", "claude"]
  return {
    storeFor,
    allStores: () => kinds.map(storeFor),
    storeForDirName: (dirName: string) => storeFor(descriptorForDirName(dirName).kind),
    storeForPath: (filePath: string) => kinds
      .map(storeFor)
      .find((store) => store.ownsPath(filePath)) ?? null,
  }
})

vi.mock("../../agents/runtimes", () => ({
  runtimeFor: () => ({
    activity: (sessionId: string) => ({ live: false, running: mocks.runtimeRunning(sessionId) === true }),
  }),
}))

vi.mock("../../lib/sessionPrSearchIndex", () => ({
  getSessionPrSearchSnapshot: mocks.getSessionPrSearchSnapshot,
}))

import {
  getSessionMeta,
  getSessionStatus,
  readFile,
} from "../../helpers"
import { projectDirToReadableName } from "../../lib/projectNames"
import { findJsonlPath, resolveSessionFilePath } from "../../sessionPaths"

const mockedFindJsonlPath = vi.mocked(findJsonlPath)
const mockedProjectDirToReadableName = vi.mocked(projectDirToReadableName)
const mockedGetSessionMeta = vi.mocked(getSessionMeta)
const mockedGetSessionStatus = vi.mocked(getSessionStatus)
const mockedReadFile = vi.mocked(readFile)
const mockedResolveSessionFilePath = vi.mocked(resolveSessionFilePath)

import type { UseFn, Middleware } from "../../helpers"
import {
  asIncomingMessage,
  asServerResponse,
  getRouteHandler,
  makeSessionMeta,
} from "../http-fixtures"
import { registerProjectRoutes } from "../../routes/projects"
import { descriptorFor } from "../../../shared/session/agent-descriptors"

const COPILOT_SESSION_ID = "68596e24-db5d-46a4-86fe-9d82425f36d7"

/** A transcript as the Claude store lists it: the path names the project. */
function claudeFile(dirName: string, fileName: string, mtimeMs: number, size = 100) {
  return { dirName, fileName, filePath: `/tmp/test-projects/${dirName}/${fileName}`, mtimeMs, size }
}

const codexDirName = (cwd: string) => descriptorFor("codex").dirName.encode(cwd)
const copilotDirName = (cwd: string) => descriptorFor("copilot").dirName.encode(cwd)

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
    mockedGetSessionStatus.mockResolvedValue({ status: "idle" as const })
    for (const kind of ["claude", "codex", "copilot"]) {
      mocks.listProjects[kind].mockResolvedValue([])
      mocks.listProjectSessionFiles[kind].mockResolvedValue([])
      mocks.listTopLevelSessions[kind].mockResolvedValue([])
      mocks.listSubagentFiles[kind].mockResolvedValue([])
      mocks.listSessionFiles[kind].mockResolvedValue([])
      mocks.sessionAddress[kind].mockResolvedValue(null)
    }
    mocks.runtimeRunning.mockReturnValue(false)
    mocks.getSessionPrSearchSnapshot.mockResolvedValue({
      byFile: new Map(),
      pending: 0,
      total: 0,
    })
    mockedResolveSessionFilePath.mockImplementation(async (dirName: string, fileName: string) => `/tmp/test-projects/${dirName}/${fileName}`)
    mockedFindJsonlPath.mockResolvedValue(null)
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

    it("returns every store's projects sorted by last modified", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")

      mocks.listProjects.claude.mockResolvedValue([
        { dirName: "proj-a", path: "/proj/a", sessionCount: 1, lastModified: new Date(1000).toISOString() },
        { dirName: "proj-b", path: "/proj/b", sessionCount: 2, lastModified: new Date(2000).toISOString() },
      ])
      mocks.listProjects.codex.mockResolvedValue([
        { dirName: codexDirName("/code/codex-only"), path: "/code/codex-only", sessionCount: 1, lastModified: new Date(3000).toISOString() },
      ])
      mockedProjectDirToReadableName.mockImplementation((dirName: string) => ({
        path: `/${dirName}`,
        shortName: dirName.replace("proj-", ""),
      }))

      await handler(req, res, next)

      expect(JSON.parse(res._getData())).toEqual([
        expect.objectContaining({ dirName: codexDirName("/code/codex-only"), shortName: "codex-only (Codex)", sessionCount: 1 }),
        expect.objectContaining({ dirName: "proj-b", shortName: "b", sessionCount: 2 }),
        expect.objectContaining({ dirName: "proj-a", shortName: "a", sessionCount: 1 }),
      ])
    })

    it("labels Copilot projects with their suffix", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")
      mocks.listProjects.copilot.mockResolvedValue([
        { dirName: copilotDirName("/code/copilot"), path: "/code/copilot", sessionCount: 1, lastModified: null },
      ])

      await handler(req, res, next)

      expect(JSON.parse(res._getData())).toEqual([
        expect.objectContaining({
          dirName: copilotDirName("/code/copilot"),
          path: "/code/copilot",
          shortName: "copilot (Copilot)",
          sessionCount: 1,
        }),
      ])
    })

    it("returns 500 when a store cannot list its projects", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("GET", "/")
      mocks.listProjects.claude.mockRejectedValueOnce(
        Object.assign(new Error("EPERM"), { code: "EPERM" }),
      )

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("handles empty URL as root path", async () => {
      const handler = getRouteHandler(handlers, "/api/projects")
      const { req, res, next } = createMockReqRes("GET", "")

      await handler(req, res, next)

      expect(JSON.parse(res._getData())).toEqual([])
    })
  })

  describe("GET /api/codex-subagents", () => {
    it("returns Codex subagents with read-only virtual paths", async () => {
      const handler = getRouteHandler(handlers, "/api/codex-subagents")
      const { req, res, next } = createMockReqRes("GET", "/")
      mocks.listSessionFiles.codex.mockResolvedValueOnce([
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
          dirName: codexDirName("/code/cogpit"),
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

    it("returns 403 when the store refuses the dirName", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "..%2F..%2Fetc")
      mocks.listProjectSessionFiles.claude.mockResolvedValueOnce(null)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(403)
      expect(mocks.listProjectSessionFiles.claude).toHaveBeenCalledWith("../../etc")
    })

    it("lists sessions with pagination, newest first", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a?page=1&limit=10")
      mocks.listProjectSessionFiles.claude.mockResolvedValueOnce([
        claudeFile("proj-a", "s2.jsonl", 1000, 200),
        claudeFile("proj-a", "s1.jsonl", 2000, 100),
      ])
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
      expect(response.sessions[0].sessionId).toBe("s1")
    })

    it("reports each session's agent status and last activity", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-status")
      mocks.listProjectSessionFiles.claude.mockResolvedValueOnce([
        claudeFile("proj-status", "live.jsonl", 5000, 120),
      ])
      mockedGetSessionMeta.mockResolvedValueOnce(makeSessionMeta({
        sessionId: "live", aiTitle: "Densify the rows", model: "claude-opus-4-1",
        gitBranch: "main", cwd: "/code/cogpit", firstUserMessage: "start",
        lastUserMessage: "keep going", timestamp: "2026-08-21T10:00:00.000Z",
        lastTimestamp: "2026-08-21T11:00:00.000Z", turnCount: 7, lineCount: 40,
      }))
      mockedGetSessionStatus.mockResolvedValueOnce({ status: "tool_use" as const, toolName: "Bash" })

      await handler(req, res, next)

      expect(JSON.parse(res._getData()).sessions[0]).toEqual(expect.objectContaining({
        sessionId: "live",
        aiTitle: "Densify the rows",
        lastUserMessage: "keep going",
        lastActivityAt: "2026-08-21T11:00:00.000Z",
        agentStatus: "tool_use",
        agentToolName: "Bash",
        turnCount: 7,
      }))
    })

    it("returns 500 when the store cannot list the project", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a")
      mocks.listProjectSessionFiles.claude.mockRejectedValueOnce(new Error("EPERM"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("falls back gracefully when getSessionMeta fails", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a")
      mocks.listProjectSessionFiles.claude.mockResolvedValueOnce([
        claudeFile("proj-a", "bad.jsonl", 1000, 50),
      ])
      mockedGetSessionMeta.mockRejectedValueOnce(new Error("parse error"))

      await handler(req, res, next)

      const response = JSON.parse(res._getData())
      expect(response.sessions).toHaveLength(1)
      expect(response.sessions[0].sessionId).toBe("bad")
      expect(response.sessions[0].fileName).toBe("bad.jsonl")
    })

    it("keeps a listing's own session id when it carries one", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const dirName = copilotDirName("/code/copilot")
      const { req, res, next } = createMockReqRes("GET", dirName)
      mocks.listProjectSessionFiles.copilot.mockResolvedValueOnce([{
        dirName,
        fileName: `${COPILOT_SESSION_ID}/events.jsonl`,
        filePath: `/tmp/copilot-sessions/${COPILOT_SESSION_ID}/events.jsonl`,
        mtimeMs: 4000,
        size: 700,
        sessionId: COPILOT_SESSION_ID,
      }])
      mockedGetSessionMeta.mockRejectedValueOnce(new Error("incomplete write"))

      await handler(req, res, next)

      expect(mocks.listProjectSessionFiles.copilot).toHaveBeenCalledWith(dirName)
      expect(JSON.parse(res._getData()).sessions).toEqual([
        expect.objectContaining({
          fileName: `${COPILOT_SESSION_ID}/events.jsonl`,
          sessionId: COPILOT_SESSION_ID,
        }),
      ])
    })
  })

  // ── GET /api/sessions/:dirName/:sessionId/subagents ──────────────────

  describe("GET /api/sessions/:dirName/:sessionId/subagents", () => {
    it("returns the store's listing", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a/session-1/subagents")
      mocks.listSubagentFiles.claude.mockResolvedValueOnce([
        { agentId: "abc", size: 10, modifiedAt: 5 },
      ])

      await handler(req, res, next)

      expect(mocks.listSubagentFiles.claude).toHaveBeenCalledWith("proj-a", "session-1")
      expect(JSON.parse(res._getData())).toEqual([{ agentId: "abc", size: 10, modifiedAt: 5 }])
    })

    it("returns 403 when the store refuses the address", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "..%2F..%2Fetc/session-1/subagents")
      mocks.listSubagentFiles.claude.mockResolvedValueOnce(null)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(403)
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
      mockedReadFile.mockResolvedValueOnce('{"line":1}\n{"line":2}\n' as unknown as Buffer)

      await handler(req, res, next)

      expect(res._getData()).toBe('{"line":1}\n{"line":2}\n')
      expect(res._getHeaders()["Content-Type"]).toBe("text/plain")
    })

    it("serves a nested path exactly as the owning store resolves it", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes(
        "GET",
        "codex__project/parent-1/subagents/agent-sub-1.jsonl"
      )
      mockedResolveSessionFilePath.mockResolvedValueOnce("/tmp/codex-sessions/2026/07/15/rollout-sub-1.jsonl")
      mockedReadFile.mockResolvedValueOnce('{"type":"session_meta"}\n' as unknown as Buffer)

      await handler(req, res, next)

      expect(mockedResolveSessionFilePath).toHaveBeenCalledWith(
        "codex__project",
        "parent-1/subagents/agent-sub-1.jsonl",
      )
      expect(mockedReadFile).toHaveBeenCalledWith(
        "/tmp/codex-sessions/2026/07/15/rollout-sub-1.jsonl",
        "utf-8"
      )
      expect(res._getStatus()).toBe(200)
    })

    it("serves a Copilot UUID events path from its provider root", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const filePath = `/tmp/copilot-sessions/${COPILOT_SESSION_ID}/events.jsonl`
      const { req, res, next } = createMockReqRes(
        "GET",
        `copilot__project/${COPILOT_SESSION_ID}/events.jsonl`,
      )
      mockedResolveSessionFilePath.mockResolvedValueOnce(filePath)
      mockedReadFile.mockResolvedValueOnce('{"type":"session.start"}\n' as unknown as Buffer)

      await handler(req, res, next)

      expect(mockedResolveSessionFilePath).toHaveBeenCalledWith(
        "copilot__project",
        `${COPILOT_SESSION_ID}/events.jsonl`,
      )
      expect(mockedReadFile).toHaveBeenCalledWith(filePath, "utf-8")
      expect(res._getStatus()).toBe(200)
    })

    it("returns 404 when file not found", async () => {
      const handler = getRouteHandler(handlers, "/api/sessions/")
      const { req, res, next } = createMockReqRes("GET", "proj-a/missing.jsonl")
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

      mocks.listTopLevelSessions.claude.mockResolvedValue([
        claudeFile("proj-a", "s1.jsonl", Date.now(), 500),
      ])
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

    it("finds a session that worked on a PR by project and exact number", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "?search=honest-cms%20%23157")

      mocks.listTopLevelSessions.claude.mockResolvedValue([
        claudeFile("-work-honest-cms", "worked-on-pr.jsonl", Date.now(), 500),
      ])
      mockedGetSessionMeta.mockResolvedValueOnce(makeSessionMeta({
        sessionId: "worked-on-pr", version: "", gitBranch: "fix/pr-157", model: "claude",
        slug: "fix-pr", cwd: "/work/honest-cms", firstUserMessage: "Fix the PR",
        lastUserMessage: "Checks are green", timestamp: "", turnCount: 3, lineCount: 10,
      }))
      mockedProjectDirToReadableName.mockReturnValueOnce({
        path: "/work/honest-cms",
        shortName: "honest-cms",
      })
      const filePath = "/tmp/test-projects/-work-honest-cms/worked-on-pr.jsonl"
      mocks.getSessionPrSearchSnapshot.mockResolvedValueOnce({
        byFile: new Map([[filePath, {
          pullRequests: [],
          references: [{ number: 157, repo: "HonestCMS/cms" }],
        }]]),
        pending: 0,
        total: 1,
      })

      await handler(req, res, next)

      expect(JSON.parse(res._getData())).toEqual([
        expect.objectContaining({
          sessionId: "worked-on-pr",
          projectShortName: "honest-cms",
          matchedPullRequestNumber: 157,
        }),
      ])
      expect(mocks.getSessionPrSearchSnapshot).toHaveBeenCalledWith([
        expect.objectContaining({ filePath, size: 500 }),
      ])
      expect(res._getHeaders()["X-Cogpit-PR-Index-Pending"]).toBe("0")
    })

    it("sorts active sessions by displayed activity time when it differs from file mtime", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "?limit=10")

      mocks.listTopLevelSessions.claude.mockResolvedValue([
        claudeFile("proj-a", "mtime-newer.jsonl", Date.parse("2026-03-21T12:00:00.000Z"), 200),
        claudeFile("proj-a", "activity-newer.jsonl", Date.parse("2026-03-21T11:00:00.000Z"), 200),
      ])

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

    it("lists nothing when no store finds transcripts", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")

      await handler(req, res, next)

      expect(JSON.parse(res._getData())).toEqual([])
    })

    it("marks a session active from its runtime's own turn state", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")
      mocks.listTopLevelSessions.codex.mockResolvedValue([{
        dirName: codexDirName("/code/codex-only"),
        fileName: "rollout-codex-active.jsonl",
        filePath: "/tmp/codex-sessions/rollout-codex-active.jsonl",
        mtimeMs: Date.now(),
        size: 400,
        projectPath: "/code/codex-only",
        sessionId: "codex-active",
      }])
      mockedGetSessionMeta.mockResolvedValue(makeSessionMeta({
        sessionId: "codex-active", version: "", gitBranch: "main", model: "gpt-5.6-terra",
        slug: "", cwd: "/code/codex-only", firstUserMessage: "hello", lastUserMessage: "bye",
        timestamp: "", turnCount: 2, lineCount: 4,
      }))
      mocks.runtimeRunning.mockImplementation((sessionId: string) => sessionId === "codex-active")

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

    it("does not consult the runtime for an agent whose transcript is authoritative", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")
      mocks.listTopLevelSessions.claude.mockResolvedValue([
        claudeFile("proj-a", "s1.jsonl", Date.now(), 500),
      ])
      mockedGetSessionMeta.mockResolvedValueOnce(makeSessionMeta({ sessionId: "s1", cwd: "/code" }))
      mockedProjectDirToReadableName.mockReturnValueOnce({ path: "/proj/a", shortName: "a" })
      mocks.runtimeRunning.mockReturnValue(true)

      await handler(req, res, next)

      expect(JSON.parse(res._getData())[0].isActive).toBe(false)
      expect(mocks.runtimeRunning).not.toHaveBeenCalled()
    })

    it("returns Copilot rows with nested file identity and a UUID sessionId", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")
      mocks.listTopLevelSessions.copilot.mockResolvedValue([{
        dirName: copilotDirName("/code/copilot"),
        fileName: `${COPILOT_SESSION_ID}/events.jsonl`,
        filePath: `/tmp/copilot-sessions/${COPILOT_SESSION_ID}/events.jsonl`,
        mtimeMs: Date.now(),
        size: 700,
        projectPath: "/code/copilot",
        sessionId: COPILOT_SESSION_ID,
      }])
      mockedGetSessionMeta.mockResolvedValueOnce(makeSessionMeta({
        sessionId: "events",
        version: "1.0.81",
        gitBranch: "main",
        model: "gpt-5",
        slug: "",
        cwd: "/code/copilot",
        firstUserMessage: "hello",
        lastUserMessage: "done",
        timestamp: "",
        turnCount: 1,
        lineCount: 5,
      }))

      await handler(req, res, next)

      expect(JSON.parse(res._getData())).toEqual([
        expect.objectContaining({
          dirName: copilotDirName("/code/copilot"),
          fileName: `${COPILOT_SESSION_ID}/events.jsonl`,
          sessionId: COPILOT_SESSION_ID,
          projectShortName: "copilot (Copilot)",
        }),
      ])
    })

    it("returns 500 when a store cannot list its sessions", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")

      mocks.listTopLevelSessions.claude.mockRejectedValueOnce(
        Object.assign(new Error("EPERM"), { code: "EPERM" }),
      )

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
      const response = JSON.parse(res._getData())
      expect(response.code).toBe("INTERNAL_ERROR")
    })

    it("marks old sessions as not active", async () => {
      const handler = getRouteHandler(handlers, "/api/active-sessions")
      const { req, res, next } = createMockReqRes("GET", "/")

      const oldTime = Date.now() - 10 * 60 * 1000 // 10 minutes ago
      mocks.listTopLevelSessions.claude.mockResolvedValue([
        claudeFile("proj-a", "old.jsonl", oldTime, 100),
      ])
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

    it("answers with the owning store's address for the found transcript", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc-123")
      mockedFindJsonlPath.mockResolvedValueOnce("/tmp/test-projects/proj-b/abc-123.jsonl")
      mocks.sessionAddress.claude.mockResolvedValueOnce({ dirName: "proj-b", fileName: "abc-123.jsonl" })

      await handler(req, res, next)

      expect(mocks.sessionAddress.claude).toHaveBeenCalledWith("/tmp/test-projects/proj-b/abc-123.jsonl")
      expect(JSON.parse(res._getData())).toEqual({ dirName: "proj-b", fileName: "abc-123.jsonl" })
    })

    it("asks the store whose root holds the transcript", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", COPILOT_SESSION_ID)
      const filePath = `/tmp/copilot-sessions/${COPILOT_SESSION_ID}/events.jsonl`
      mockedFindJsonlPath.mockResolvedValueOnce(filePath)
      mocks.sessionAddress.copilot.mockResolvedValueOnce({
        dirName: copilotDirName("/code/copilot"),
        fileName: `${COPILOT_SESSION_ID}/events.jsonl`,
      })

      await handler(req, res, next)

      expect(mocks.sessionAddress.copilot).toHaveBeenCalledWith(filePath)
      expect(mocks.sessionAddress.claude).not.toHaveBeenCalled()
      expect(JSON.parse(res._getData())).toEqual({
        dirName: copilotDirName("/code/copilot"),
        fileName: `${COPILOT_SESSION_ID}/events.jsonl`,
      })
    })

    it("returns 404 when session not found", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "nonexistent")
      mockedFindJsonlPath.mockResolvedValueOnce(null)

      await handler(req, res, next)

      expect(res._getStatus()).toBe(404)
    })

    it("returns 500 on lookup errors", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc-123")
      mockedFindJsonlPath.mockRejectedValueOnce(new Error("ENOENT"))

      await handler(req, res, next)

      expect(res._getStatus()).toBe(500)
    })

    it("calls next when URL has multiple path segments", async () => {
      const handler = getRouteHandler(handlers, "/api/find-session/")
      const { req, res, next } = createMockReqRes("GET", "abc/extra")
      await handler(req, res, next)
      expect(next).toHaveBeenCalled()
    })
  })
})
