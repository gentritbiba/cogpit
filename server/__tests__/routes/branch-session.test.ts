// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { UseFn, Middleware } from "../../helpers"

// Mock helpers module
vi.mock("../../helpers", () => ({
  dirs: {
    PROJECTS_DIR: "/tmp/test-projects",
  },
  dirname: vi.fn((path: string) => path.split("/").slice(0, -1).join("/")),
  isWithinDir: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
  randomUUID: vi.fn(() => "new-uuid-1234"),
  // Stubs for other exports the route file imports
  activeProcesses: new Map(),
  persistentSessions: new Map(),
  watchSubagents: vi.fn(),
  spawn: vi.fn(),
  createInterface: vi.fn(),
  readdir: vi.fn(),
  open: vi.fn(),
  stat: vi.fn(),
}))

vi.mock("../../agents/spawnError", () => ({ friendlySpawnError: vi.fn() }))

vi.mock("../../sessionPaths", () => ({
  resolveSessionFilePath: vi.fn(
    (dirName: string, fileName: string) => `/tmp/test-projects/${dirName}/${fileName}`,
  ),
  findJsonlPath: vi.fn(),
  findNewestCodexSessionForCwd: vi.fn(),
}))

vi.mock("../../agents", async () => {
  const { resolve, sep } = await vi.importActual<typeof import("node:path")>("node:path")
  const { descriptorFor, descriptorForDirName } = await vi.importActual<
    typeof import("../../../shared/session/agent-descriptors")
  >("../../../shared/session/agent-descriptors")
  const roots: Record<string, string> = {
    claude: "/tmp/test-projects",
    codex: "/tmp/test-codex-sessions",
    copilot: "/tmp/copilot/session-state",
  }
  const storeFor = (kind: string) => ({
    kind,
    sessionsRoot: () => roots[kind],
    // Mirrors the real stores: Claude nests by project, the rest by their own naming.
    transcriptPath: (dirName: string, sessionId: string) => {
      const fileName = descriptorFor(kind as "claude").sessionFile.name(sessionId)
      return {
        fileName,
        filePath: [roots[kind], ...(kind === "claude" ? [dirName] : []), fileName].join("/"),
      }
    },
  })
  return {
    storeFor,
    storeForDirName: (dirName: string) => storeFor(descriptorForDirName(dirName).kind),
    storeForPath: (filePath: string) => {
      const resolved = resolve(filePath)
      const kind = Object.keys(roots).find((key) => (
        resolved.startsWith(`${resolve(roots[key])}${sep}`)
      ))
      return kind ? { kind } : null
    },
  }
})

vi.mock("../../agents/copilotTransport", () => ({
  copilotRuntime: {
    forkSession: vi.fn(),
  },
}))

// The real Copilot adapter over the mocked transport, so the turn-to-event
// mapping the fork relies on is exercised rather than restated here.
vi.mock("../../agents/runtimes", async () => {
  const { copilotRuntime } = await vi.importActual<
    typeof import("../../agents/copilotRuntime")
  >("../../agents/copilotRuntime")
  return { runtimeForDirName: () => copilotRuntime }
})

import {
  isWithinDir,
  mkdir,
  readFile,
  writeFile,
} from "../../helpers"
import { resolveSessionFilePath } from "../../sessionPaths"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { copilotRuntime } from "../../agents/copilotTransport"
import { registerSessionNewRoutes } from "../../routes/session-new"

const CODEX_DIR_NAME = descriptorFor("codex").dirName
  .encode("/Users/gentritbiba/.claude/agent-window")
const COPILOT_DIR_NAME = descriptorFor("copilot").dirName.encode("/Users/gentritbiba/project")
const mockedForkCopilotSession = vi.mocked(copilotRuntime.forkSession)
const mockedIsWithinDir = vi.mocked(isWithinDir)
const mockedMkdir = vi.mocked(mkdir)
const mockedReadFile = vi.mocked(readFile)
const mockedResolveSessionFilePath = vi.mocked(resolveSessionFilePath)
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
  mockedForkCopilotSession.mockResolvedValue({ sessionId: "forked-copilot" })
  mockedResolveSessionFilePath.mockImplementation(
    async (dirName: string, fileName: string) =>
      `/tmp/test-projects/${dirName}/${fileName}`
  )
  mockedIsWithinDir.mockReturnValue(true)
  mockedMkdir.mockResolvedValue(undefined as never)

  handlers = new Map()
  const use: UseFn = (path: string, handler: Middleware) => {
    handlers.set(path, handler)
  }
  registerSessionNewRoutes(use)
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

function buildCodexJsonl(turnCount: number, sessionId = "original-codex-session"): string {
  const lines: string[] = [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: sessionId,
        cwd: "/test-codex",
        model: "gpt-5-codex",
      },
    }),
  ]

  for (let t = 0; t < turnCount; t++) {
    lines.push(JSON.stringify({ type: "turn_context", payload: { cwd: "/test-codex" } }))
    lines.push(
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: `User message ${t}`,
        },
      })
    )
    lines.push(
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "assistant_message",
          message: `Response ${t}`,
        },
      })
    )
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
    mockedResolveSessionFilePath.mockResolvedValue(null as never)

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

  it("does not treat a mixed tool-result record as the start of a turn", async () => {
    // This is the case the client and the server used to disagree on: the
    // client rejected a user record carrying *any* tool_result block, the
    // server only one where *every* block was. The client computes keepLines
    // and the server verifies it, so a disagreement here truncates a turn early
    // and writes a corrupted transcript. One scan now, and `some` wins.
    mockedIsWithinDir.mockReturnValue(true)
    mockedReadFile.mockResolvedValue([
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "first" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [] } }),
      JSON.stringify({
        type: "user",
        uuid: "mixed-1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
            { type: "text", text: "and also do this" },
          ],
        },
      }),
      JSON.stringify({ type: "user", uuid: "u2", message: { role: "user", content: "second" } }),
    ].join("\n") as never)
    mockedWriteFile.mockResolvedValue(undefined as never)

    const { res } = callHandler(
      "/api/branch-session",
      "POST",
      JSON.stringify({
        dirName: "my-project",
        fileName: "original-session-id.jsonl",
        turnIndex: 0,
      }),
    )

    await vi.waitFor(() => {
      expect(res.statusCode).toBe(200)
      expect(res.body).toBeTruthy()
    })

    const writtenLines = (mockedWriteFile.mock.calls[0][1] as string).trim().split("\n")
    expect(writtenLines).toHaveLength(3)
    expect(JSON.parse(writtenLines[2]).uuid).toBe("mixed-1")
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

  it("truncates at turnUuid when provided, ignoring a mismatched turnIndex", async () => {
    mockedIsWithinDir.mockReturnValue(true)
    const sourceContent = buildJsonl(3)
    mockedReadFile.mockResolvedValue(sourceContent as never)
    mockedWriteFile.mockResolvedValue(undefined as never)

    // Simulates a tail-loaded client: its local turnIndex (0) does NOT match
    // the file-order turn, but the boundary uuid (u1 = file turn 1) does.
    const { res } = callHandler(
      "/api/branch-session",
      "POST",
      JSON.stringify({
        dirName: "my-project",
        fileName: "original-session-id.jsonl",
        turnIndex: 0,
        turnUuid: "u1",
      })
    )

    await vi.waitFor(() => {
      expect(res.body).toBeTruthy()
      expect(res.statusCode).toBe(200)
    })

    // uuid cut wins: keep turns 0 and 1 (4 lines), not just turn 0 (2 lines)
    const writtenContent = mockedWriteFile.mock.calls[0][1] as string
    const writtenLines = writtenContent.trim().split("\n")
    expect(writtenLines).toHaveLength(4)
  })

  it("keeps all lines when turnUuid belongs to the last turn", async () => {
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
        turnUuid: "u2",
      })
    )

    await vi.waitFor(() => {
      expect(res.body).toBeTruthy()
      expect(res.statusCode).toBe(200)
    })

    // uuid resolved to the last turn → no truncation; index fallback unused
    const writtenContent = mockedWriteFile.mock.calls[0][1] as string
    const writtenLines = writtenContent.trim().split("\n")
    expect(writtenLines).toHaveLength(6)
  })

  it("falls back to turnIndex when turnUuid matches no line", async () => {
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
        turnUuid: "queued-synthetic-id",
      })
    )

    await vi.waitFor(() => {
      expect(res.body).toBeTruthy()
      expect(res.statusCode).toBe(200)
    })

    // unmatched uuid → index cut applies: keep only turn 0
    const writtenContent = mockedWriteFile.mock.calls[0][1] as string
    const writtenLines = writtenContent.trim().split("\n")
    expect(writtenLines).toHaveLength(2)
  })

  it("branches Codex sessions with rollout naming and metadata", async () => {
    mockedResolveSessionFilePath.mockResolvedValue(
      "/tmp/test-codex-sessions/2026/03/18/original.jsonl" as never
    )
    mockedReadFile.mockResolvedValue(buildCodexJsonl(2) as never)
    mockedWriteFile.mockResolvedValue(undefined as never)

    const { res } = callHandler(
      "/api/branch-session",
      "POST",
      JSON.stringify({
        dirName: CODEX_DIR_NAME,
        fileName: "2026/03/18/original.jsonl",
        turnIndex: 0,
      })
    )

    await vi.waitFor(() => {
      expect(res.body).toBeTruthy()
      expect(res.statusCode).toBe(200)
    })

    // The rollout name is stamped with the moment the branch was written, so
    // it is pinned by shape rather than by re-deriving it from a second clock read.
    const ROLLOUT_NAME =
      /^\d{4}\/\d{2}\/\d{2}\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-new-uuid-1234\.jsonl$/
    expect(mockedMkdir).toHaveBeenCalledTimes(1)
    const writtenPath = mockedWriteFile.mock.calls[0][0] as string
    expect(writtenPath.startsWith("/tmp/test-codex-sessions/")).toBe(true)
    const rolloutName = writtenPath.slice("/tmp/test-codex-sessions/".length)
    expect(rolloutName).toMatch(ROLLOUT_NAME)

    const writtenContent = mockedWriteFile.mock.calls[0][1] as string
    const writtenLines = writtenContent.trim().split("\n")
    expect(writtenLines).toHaveLength(4)

    const sessionMeta = JSON.parse(writtenLines[0])
    expect(sessionMeta.payload.id).toBe("new-uuid-1234")
    expect(sessionMeta.payload.branchedFrom).toEqual({
      sessionId: "original-codex-session",
      turnIndex: 0,
    })

    const data = JSON.parse(res.body)
    expect(data.fileName).toBe(
      rolloutName
    )
    expect(data.branchedFrom).toBe("original-codex-session")
  })

  it("forks a complete Copilot session through the native API", async () => {
    mockedResolveSessionFilePath.mockResolvedValue(
      "/tmp/copilot/session-state/11111111-1111-4111-8111-111111111111/events.jsonl" as never,
    )
    mockedReadFile.mockResolvedValue([
      JSON.stringify({
        type: "session.start",
        id: "start-event",
        data: { sessionId: "11111111-1111-4111-8111-111111111111" },
      }),
      JSON.stringify({
        type: "user.message",
        id: "user-event-1",
        data: { turnId: "turn-1", content: "First" },
      }),
    ].join("\n") as never)

    const { res } = callHandler(
      "/api/branch-session",
      "POST",
      JSON.stringify({
        dirName: COPILOT_DIR_NAME,
        fileName: "11111111-1111-4111-8111-111111111111/events.jsonl",
      }),
    )

    await vi.waitFor(() => expect(res.body).toBeTruthy())
    expect(mockedForkCopilotSession).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {},
    )
    expect(JSON.parse(res.body)).toEqual({
      dirName: COPILOT_DIR_NAME,
      fileName: "forked-copilot/events.jsonl",
      sessionId: "forked-copilot",
      branchedFrom: "11111111-1111-4111-8111-111111111111",
    })
    expect(mockedWriteFile).not.toHaveBeenCalled()
  })

  it("forks Copilot through the selected turn's next durable user event", async () => {
    mockedResolveSessionFilePath.mockResolvedValue(
      "/tmp/copilot/session-state/11111111-1111-4111-8111-111111111111/events.jsonl" as never,
    )
    mockedReadFile.mockResolvedValue([
      JSON.stringify({
        type: "user.message",
        id: "user-event-1",
        data: { turnId: "turn-1", content: "First" },
      }),
      JSON.stringify({
        type: "assistant.message",
        id: "assistant-event-1",
        data: { content: "Done" },
      }),
      JSON.stringify({
        type: "user.message",
        id: "user-event-2",
        data: { turnId: "turn-2", content: "Second" },
      }),
      JSON.stringify({
        type: "user.message",
        id: "nested-user-event",
        agentId: "subagent-1",
        data: { turnId: "nested", content: "Nested" },
      }),
      JSON.stringify({
        type: "user.message",
        id: "user-event-3",
        data: { turnId: "turn-3", content: "Third" },
      }),
    ].join("\n") as never)

    const { res } = callHandler(
      "/api/branch-session",
      "POST",
      JSON.stringify({
        dirName: COPILOT_DIR_NAME,
        fileName: "11111111-1111-4111-8111-111111111111/events.jsonl",
        turnIndex: 0,
        turnUuid: "turn-2@user-event-2",
      }),
    )

    await vi.waitFor(() => expect(res.body).toBeTruthy())
    expect(mockedForkCopilotSession).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { toEventId: "user-event-3" },
    )
  })
})
