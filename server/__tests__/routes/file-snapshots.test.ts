// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../helpers", () => ({
  findJsonlPath: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  homedir: () => "/mock-home",
  join: (...parts: string[]) => parts.join("/"),
  sendJson: (res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void }, status: number, data: unknown) => {
    res.statusCode = status
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify(data))
  },
}))

import { findJsonlPath, readFile } from "../../helpers"
import {
  parseFileSnapshots,
  registerFileSnapshotRoutes,
} from "../../routes/file-snapshots"
import type { UseFn, Middleware } from "../../helpers"

const mockedFindJsonlPath = vi.mocked(findJsonlPath)
const mockedReadFile = vi.mocked(readFile)

// ── JSONL helpers ─────────────────────────────────────────────────────────────

function snapshotLine(
  messageId: string,
  backups: Record<string, { backupFileName: string | null; version: number }>,
  isUpdate = false,
) {
  return JSON.stringify({
    type: "file-history-snapshot",
    messageId,
    snapshot: {
      messageId,
      trackedFileBackups: Object.fromEntries(
        Object.entries(backups).map(([path, info]) => [
          path,
          { backupFileName: info.backupFileName, version: info.version, backupTime: "2026-01-01T00:00:00Z" },
        ]),
      ),
      timestamp: "2026-01-01T00:00:00Z",
    },
    isSnapshotUpdate: isUpdate,
  })
}

function makeJsonl(...lines: string[]) {
  return lines.join("\n")
}

// ── parseFileSnapshots ─────────────────────────────────────────────────────────

describe("parseFileSnapshots", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns empty map for JSONL with no snapshots", () => {
    const result = parseFileSnapshots("")
    expect(result.size).toBe(0)
  })

  it("extracts file with backup versions", () => {
    const jsonl = makeJsonl(
      snapshotLine("msg1", {
        "src/app.ts": { backupFileName: "abc123@v1", version: 1 },
      }),
      snapshotLine("msg2", {
        "src/app.ts": { backupFileName: "abc123@v3", version: 3 },
      }),
    )
    const result = parseFileSnapshots(jsonl)
    expect(result.size).toBe(1)
    const info = result.get("src/app.ts")!
    expect(info.earliestBackup).toBe("abc123@v1")
    expect(info.latestBackup).toBe("abc123@v3")
    expect(info.earliestVersion).toBe(1)
    expect(info.latestVersion).toBe(3)
  })

  it("handles files with null backupFileName (new files)", () => {
    const jsonl = makeJsonl(
      snapshotLine("msg1", {
        "new-file.ts": { backupFileName: null, version: 1 },
      }),
      snapshotLine("msg2", {
        "new-file.ts": { backupFileName: null, version: 3 },
      }),
    )
    const result = parseFileSnapshots(jsonl)
    const info = result.get("new-file.ts")!
    expect(info.earliestBackup).toBeNull()
    expect(info.latestBackup).toBeNull()
  })

  it("tracks multiple files independently", () => {
    const jsonl = makeJsonl(
      snapshotLine("msg1", {
        "a.ts": { backupFileName: "hash1@v1", version: 1 },
        "b.ts": { backupFileName: "hash2@v1", version: 1 },
      }),
      snapshotLine("msg2", {
        "a.ts": { backupFileName: "hash1@v2", version: 2 },
        "b.ts": { backupFileName: "hash2@v1", version: 1 },
      }),
    )
    const result = parseFileSnapshots(jsonl)
    expect(result.size).toBe(2)
    expect(result.get("a.ts")!.latestBackup).toBe("hash1@v2")
    expect(result.get("b.ts")!.latestBackup).toBe("hash2@v1")
  })

  it("handles non-snapshot lines gracefully", () => {
    const jsonl = makeJsonl(
      JSON.stringify({ type: "user", message: { content: [] } }),
      snapshotLine("msg1", {
        "x.ts": { backupFileName: "h@v1", version: 1 },
      }),
      JSON.stringify({ type: "assistant", message: { content: [] } }),
    )
    const result = parseFileSnapshots(jsonl)
    expect(result.size).toBe(1)
    expect(result.get("x.ts")).toBeDefined()
  })
})

// ── HTTP route tests ──────────────────────────────────────────────────────────

function createMockReqRes(method: string, url: string) {
  let statusCode = 200
  const headers: Record<string, string> = {}
  let body = ""

  const req = {
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
  }

  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v }),
    end: vi.fn((data?: string) => { body = data || "" }),
    _getData: () => body,
    _getStatus: () => statusCode,
  }

  const next = vi.fn()
  return { req, res, next }
}

describe("registerFileSnapshotRoutes", () => {
  let handlers: Map<string, Middleware>

  beforeEach(() => {
    vi.clearAllMocks()
    handlers = new Map()
    const use: UseFn = (path, handler) => { handlers.set(path, handler) }
    registerFileSnapshotRoutes(use)
  })

  it("registers the route", () => {
    expect(handlers.has("/api/file-snapshots/")).toBe(true)
  })

  it("calls next for non-GET methods", async () => {
    const handler = handlers.get("/api/file-snapshots/")!
    const { req, res, next } = createMockReqRes("POST", "/session-abc")
    await handler(req as never, res as never, next)
    expect(next).toHaveBeenCalled()
  })

  it("returns 404 when session not found", async () => {
    mockedFindJsonlPath.mockResolvedValueOnce(null)
    const handler = handlers.get("/api/file-snapshots/")!
    const { req, res, next } = createMockReqRes("GET", "/missing-session")
    await handler(req as never, res as never, next)
    expect(res._getStatus()).toBe(404)
    expect(JSON.parse(res._getData())).toMatchObject({ error: "Session not found" })
  })

  it("returns snapshot data with before/after content for a file", async () => {
    const sessionId = "test-session-123"
    mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")

    // JSONL with snapshot entries
    mockedReadFile.mockImplementation(async (path: string) => {
      const p = path as string
      if (p.endsWith(".jsonl")) {
        return makeJsonl(
          snapshotLine("msg1", {
            "src/app.ts": { backupFileName: "abc123@v1", version: 1 },
          }),
          snapshotLine("msg2", {
            "src/app.ts": { backupFileName: "abc123@v3", version: 3 },
          }),
        ) as never
      }
      // Backup file reads
      if (p.includes("abc123@v1")) return "const x = 1\n" as never
      if (p.includes("abc123@v3")) return "const x = 42\n" as never
      throw new Error(`Unexpected read: ${p}`)
    })

    const handler = handlers.get("/api/file-snapshots/")!
    const encodedPath = encodeURIComponent("src/app.ts")
    const { req, res, next } = createMockReqRes("GET", `/${sessionId}/${encodedPath}`)
    await handler(req as never, res as never, next)
    expect(res._getStatus()).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.before).toBe("const x = 1\n")
    expect(data.after).toBe("const x = 42\n")
    expect(data.versions).toEqual([1, 3])
  })

  it("returns null for file not found in snapshots", async () => {
    mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
    mockedReadFile.mockResolvedValueOnce(
      makeJsonl(
        snapshotLine("msg1", {
          "src/other.ts": { backupFileName: "xyz@v1", version: 1 },
        }),
      ) as never,
    )

    const handler = handlers.get("/api/file-snapshots/")!
    const encodedPath = encodeURIComponent("src/missing.ts")
    const { req, res, next } = createMockReqRes("GET", `/session-abc/${encodedPath}`)
    await handler(req as never, res as never, next)
    expect(res._getStatus()).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data).toBeNull()
  })

  it("returns null content for new files (backupFileName is null)", async () => {
    mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
    mockedReadFile.mockResolvedValueOnce(
      makeJsonl(
        snapshotLine("msg1", {
          "new-file.ts": { backupFileName: null, version: 1 },
        }),
        snapshotLine("msg2", {
          "new-file.ts": { backupFileName: null, version: 3 },
        }),
      ) as never,
    )

    const handler = handlers.get("/api/file-snapshots/")!
    const encodedPath = encodeURIComponent("new-file.ts")
    const { req, res, next } = createMockReqRes("GET", `/session-abc/${encodedPath}`)
    await handler(req as never, res as never, next)
    expect(res._getStatus()).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.before).toBeNull()
    expect(data.after).toBeNull()
    expect(data.versions).toEqual([1, 3])
  })

  it("returns list of all tracked files when no filePath provided", async () => {
    mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
    mockedReadFile.mockResolvedValueOnce(
      makeJsonl(
        snapshotLine("msg1", {
          "a.ts": { backupFileName: "h1@v1", version: 1 },
          "b.ts": { backupFileName: "h2@v1", version: 1 },
        }),
        snapshotLine("msg2", {
          "a.ts": { backupFileName: "h1@v2", version: 2 },
          "b.ts": { backupFileName: "h2@v1", version: 1 },
        }),
      ) as never,
    )

    const handler = handlers.get("/api/file-snapshots/")!
    const { req, res, next } = createMockReqRes("GET", "/session-abc")
    await handler(req as never, res as never, next)
    expect(res._getStatus()).toBe(200)
    const data = JSON.parse(res._getData())
    expect(data.files).toHaveLength(2)
    expect(data.files.map((f: { filePath: string }) => f.filePath).sort()).toEqual(["a.ts", "b.ts"])
  })

  it("calls next for unknown path shapes", async () => {
    const handler = handlers.get("/api/file-snapshots/")!
    const { req, res, next } = createMockReqRes("GET", "")
    await handler(req as never, res as never, next)
    expect(next).toHaveBeenCalled()
  })
})
