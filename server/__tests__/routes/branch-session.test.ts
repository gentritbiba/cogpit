// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { UseFn, Middleware } from "../../helpers"

// Mock helpers module
vi.mock("../../helpers", () => ({
  dirs: {
    PROJECTS_DIR: "/tmp/test-projects",
  },
  isWithinDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
  randomUUID: vi.fn(() => "new-uuid-1234"),
  // Stubs for other exports the route file imports
  friendlySpawnError: vi.fn(),
  activeProcesses: new Map(),
  persistentSessions: new Map(),
  findJsonlPath: vi.fn(),
  watchSubagents: vi.fn(),
  spawn: vi.fn(),
  createInterface: vi.fn(),
  readdir: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
}))

import {
  isWithinDir,
  readFile,
  writeFile,
} from "../../helpers"
import { registerClaudeNewRoutes } from "../../routes/claude-new"

const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedReadFile = vi.mocked(readFile)
const mockedWriteFile = vi.mocked(writeFile)

// Helper to simulate Express-like routing
function createMockReqRes(method: string, url: string, body?: string) {
  const dataHandlers: ((chunk: string) => void)[] = []
  const endHandlers: (() => void)[] = []
  const req = {
    method,
    url,
    on: (event: string, handler: (chunk?: string) => void) => {
      if (event === "data") dataHandlers.push(handler as (chunk: string) => void)
      if (event === "end") endHandlers.push(handler)
    },
  }
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(key: string, value: string) {
      this.headers[key] = value
    },
    end(data?: string) {
      if (data) this.body = data
    },
  }

  // Trigger body events after registration
  const triggerBody = () => {
    if (body) {
      for (const h of dataHandlers) h(body)
    }
    for (const h of endHandlers) h()
  }

  return { req, res, triggerBody }
}

// Collect registered route handlers
let handlers: Map<string, Middleware>

beforeEach(() => {
  vi.clearAllMocks()
  handlers = new Map()
  const use: UseFn = (path: string, handler: Middleware) => {
    handlers.set(path, handler)
  }
  registerClaudeNewRoutes(use)
})

function callHandler(path: string, method: string, body?: string) {
  const handler = handlers.get(path)
  if (!handler) throw new Error(`No handler for ${path}`)

  const { req, res, triggerBody } = createMockReqRes(method, path, body)
  const nextCalled = { value: false }
  handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1], () => { nextCalled.value = true })
  triggerBody()
  return { res, nextCalled }
}

// Build a simple JSONL file with N turns
function buildJsonl(turnCount: number, sessionId = "original-session-id"): string {
  const lines: string[] = []
  for (let t = 0; t < turnCount; t++) {
    const userLine: Record<string, unknown> = {
      type: "user",
      message: { role: "user", content: `User message ${t}` },
      uuid: `u${t}`,
      timestamp: `2025-01-15T10:0${t}:00Z`,
      ...(t === 0 ? { sessionId, version: "1.0", cwd: "/test" } : {}),
    }
    lines.push(JSON.stringify(userLine))

    const assistantLine: Record<string, unknown> = {
      type: "assistant",
      message: {
        model: "claude-opus-4-6-20250115",
        id: `a${t}`,
        role: "assistant",
        content: [{ type: "text", text: `Response ${t}` }],
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      uuid: `a${t}`,
      timestamp: `2025-01-15T10:0${t}:01Z`,
    }
    lines.push(JSON.stringify(assistantLine))
  }
  return lines.join("\n")
}

describe("POST /api/branch-session", () => {
  it("calls next for non-POST requests", () => {
    const { nextCalled } = callHandler("/api/branch-session", "GET")
    expect(nextCalled.value).toBe(true)
  })

  it("returns 400 if dirName or fileName is missing", async () => {
    const { res } = callHandler(
      "/api/branch-session",
      "POST",
      JSON.stringify({ dirName: "proj" })
    )
    // Wait for async handler
    await vi.waitFor(() => {
      expect(res.statusCode).toBe(400)
    })
    expect(JSON.parse(res.body).error).toMatch(/required/)
  })

  it("returns 403 for path traversal attempt", async () => {
    mockedIsWithinDir.mockReturnValue(false)

    const { res } = callHandler(
      "/api/branch-session",
      "POST",
      JSON.stringify({ dirName: "../etc", fileName: "passwd.jsonl" })
    )
    await vi.waitFor(() => {
      expect(res.statusCode).toBe(403)
    })
    expect(JSON.parse(res.body).error).toMatch(/denied/)
  })

  it("creates a full copy with new sessionId and branchedFrom metadata", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    const sourceContent = buildJsonl(3)
    mockedReadFile.mockResolvedValue(sourceContent as never)
    mockedWriteFile.mockResolvedValue(undefined as never)

    const { res } = callHandler(
      "/api/branch-session",
      "POST",
      JSON.stringify({ dirName: "my-project", fileName: "original-session-id.jsonl" })
    )

    await vi.waitFor(() => {
      expect(res.body).toBeTruthy()
      expect(res.statusCode).toBe(200)
    })

    const data = JSON.parse(res.body)
    expect(data.sessionId).toBe("new-uuid-1234")
    expect(data.fileName).toBe("new-uuid-1234.jsonl")
    expect(data.branchedFrom).toBe("original-session-id")

    // Verify the written content has the new sessionId and branchedFrom
    expect(mockedWriteFile).toHaveBeenCalledTimes(1)
    const writtenContent = mockedWriteFile.mock.calls[0][1] as string
    const firstLine = JSON.parse(writtenContent.split("\n")[0])
    expect(firstLine.sessionId).toBe("new-uuid-1234")
    expect(firstLine.branchedFrom).toEqual({
      sessionId: "original-session-id",
      turnIndex: null,
    })

    // All 6 lines should be present (3 turns × 2 messages)
    const writtenLines = writtenContent.trim().split("\n")
    expect(writtenLines).toHaveLength(6)
  })

  it("truncates at turnIndex when provided", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    const sourceContent = buildJsonl(3)
    mockedReadFile.mockResolvedValue(sourceContent as never)
    mockedWriteFile.mockResolvedValue(undefined as never)

    const { res } = callHandler(
      "/api/branch-session",
      "POST",
      JSON.stringify({
        dirName: "my-project",
        fileName: "original-session-id.jsonl",
        turnIndex: 0,
      })
    )

    await vi.waitFor(() => {
      expect(res.body).toBeTruthy()
      expect(res.statusCode).toBe(200)
    })

    // turnIndex=0 means keep turn 0 and truncate before turn 1
    // That means lines for the first turn's user+assistant (2 lines)
    const writtenContent = mockedWriteFile.mock.calls[0][1] as string
    const writtenLines = writtenContent.trim().split("\n")
    expect(writtenLines).toHaveLength(2)

    const firstLine = JSON.parse(writtenLines[0])
    expect(firstLine.branchedFrom).toEqual({
      sessionId: "original-session-id",
      turnIndex: 0,
    })
  })

  it("keeps all lines when turnIndex >= total turns", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    const sourceContent = buildJsonl(2)
    mockedReadFile.mockResolvedValue(sourceContent as never)
    mockedWriteFile.mockResolvedValue(undefined as never)

    const { res } = callHandler(
      "/api/branch-session",
      "POST",
      JSON.stringify({
        dirName: "my-project",
        fileName: "original-session-id.jsonl",
        turnIndex: 99,
      })
    )

    await vi.waitFor(() => {
      expect(res.body).toBeTruthy()
      expect(res.statusCode).toBe(200)
    })

    // turnIndex=99 is beyond the 2 turns, so all 4 lines should be present
    const writtenContent = mockedWriteFile.mock.calls[0][1] as string
    const writtenLines = writtenContent.trim().split("\n")
    expect(writtenLines).toHaveLength(4)
  })
})
