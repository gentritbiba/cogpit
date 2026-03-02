// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("../../helpers", () => ({
  findJsonlPath: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  join: (...parts: string[]) => parts.join("/"),
  dirs: { TEAMS_DIR: "/mock/teams", TASKS_DIR: "/mock/tasks", PROJECTS_DIR: "/mock/projects" },
  matchSubagentToMember: vi.fn(),
}))

// Must mock the parser since it imports from src/lib/
vi.mock("../../../src/lib/parser", () => ({
  parseSession: vi.fn(),
}))

import { findJsonlPath, readFile, readdir } from "../../helpers"
import { parseSession } from "../../../src/lib/parser"
import { registerSessionContextRoutes } from "../../routes/session-context"
import type { UseFn, Middleware } from "../../helpers"
import type { ParsedSession, Turn, TokenUsage } from "../../../src/lib/types"

const mockedFindJsonlPath = vi.mocked(findJsonlPath)
const mockedReadFile = vi.mocked(readFile)
const mockedReaddir = vi.mocked(readdir)
const mockedParseSession = vi.mocked(parseSession)

// ── Test helpers ─────────────────────────────────────────────────────────────

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
    _getHeaders: () => headers,
  }

  const next = vi.fn()
  return { req, res, next }
}

function makeTokenUsage(input = 1000, output = 500): TokenUsage {
  return { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    userMessage: "Hello",
    contentBlocks: [],
    thinking: [],
    assistantText: ["I can help with that."],
    toolCalls: [],
    subAgentActivity: [],
    timestamp: "2026-03-02T10:00:00Z",
    durationMs: 5000,
    tokenUsage: makeTokenUsage(),
    model: "claude-opus-4-6",
    ...overrides,
  }
}

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  return {
    sessionId: "test-session-123",
    version: "1.0",
    gitBranch: "main",
    cwd: "/projects/myapp",
    slug: "myapp",
    model: "claude-opus-4-6",
    turns: [makeTurn()],
    stats: {
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalCostUSD: 0.05,
      toolCallCounts: {},
      errorCount: 0,
      totalDurationMs: 5000,
      turnCount: 1,
    },
    rawMessages: [],
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("registerSessionContextRoutes", () => {
  let handler: Middleware

  beforeEach(() => {
    vi.clearAllMocks()
    const handlers = new Map<string, Middleware>()
    const use: UseFn = (path, h) => { handlers.set(path, h) }
    registerSessionContextRoutes(use)
    handler = handlers.get("/api/session-context/")!
  })

  // ── Method guard ─────────────────────────────────────────────────────────

  it("calls next for non-GET methods", async () => {
    const { req, res, next } = createMockReqRes("POST", "/test-session")
    await handler(req as never, res as never, next)
    expect(next).toHaveBeenCalled()
  })

  // ── L1: Session Overview ─────────────────────────────────────────────────

  describe("L1 — Session Overview", () => {
    it("returns 404 when session not found", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce(null)
      const { req, res, next } = createMockReqRes("GET", "/missing-session")
      await handler(req as never, res as never, next)
      expect(res._getStatus()).toBe(404)
      expect(JSON.parse(res._getData())).toMatchObject({ error: "Session not found" })
    })

    it("returns session overview for valid session", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession())

      const { req, res, next } = createMockReqRes("GET", "/test-session-123")
      await handler(req as never, res as never, next)

      expect(res._getStatus()).toBe(200)
      const data = JSON.parse(res._getData())
      expect(data.sessionId).toBe("test-session-123")
      expect(data.cwd).toBe("/projects/myapp")
      expect(data.model).toBe("claude-opus-4-6")
      expect(data.compacted).toBe(false)
      expect(data.turns).toHaveLength(1)
      expect(data.turns[0].turnIndex).toBe(0)
      expect(data.turns[0].userMessage).toBe("Hello")
      expect(data.turns[0].assistantMessage).toBe("I can help with that.")
    })

    it("extracts text from ContentBlock[] user messages", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)

      const session = makeSession({
        turns: [makeTurn({
          userMessage: [
            { type: "text", text: "First part" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
            { type: "text", text: "Second part" },
          ],
        })],
      })
      mockedParseSession.mockReturnValueOnce(session)

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.turns[0].userMessage).toBe("First part\n[image attached]\nSecond part")
    })

    it("returns null for synthetic turns with no user message", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({ userMessage: null })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.turns[0].userMessage).toBeNull()
    })

    it("returns null assistantMessage when no text", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({ assistantText: [] })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.turns[0].assistantMessage).toBeNull()
    })

    it("trims longest messages when response exceeds 150KB", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      // Create turns with huge messages that exceed 150KB total
      const hugeTurns = Array.from({ length: 20 }, (_) =>
        makeTurn({ userMessage: "u".repeat(5000), assistantText: ["a".repeat(5000)] }),
      )
      mockedParseSession.mockReturnValueOnce(makeSession({ turns: hugeTurns }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const raw = res._getData()
      expect(raw.length).toBeLessThanOrEqual(150_000)
      const data = JSON.parse(raw)
      // At least some messages should have been trimmed
      const trimmed = data.turns.some((t: { assistantMessage: string }) =>
        t.assistantMessage?.includes("[truncated, use L2 for full text]"),
      )
      expect(trimmed).toBe(true)
    })

    it("returns full messages when under 150KB limit", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      const msg = "x".repeat(1000)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({ userMessage: msg, assistantText: [msg] })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.turns[0].userMessage).toBe(msg)
      expect(data.turns[0].assistantMessage).toBe(msg)
    })

    it("builds toolSummary from tool calls", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          toolCalls: [
            { id: "tc1", name: "Read", input: {}, result: "ok", isError: false, timestamp: "" },
            { id: "tc2", name: "Read", input: {}, result: "ok", isError: false, timestamp: "" },
            { id: "tc3", name: "Edit", input: {}, result: "ok", isError: false, timestamp: "" },
          ],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.turns[0].toolSummary).toEqual({ Read: 2, Edit: 1 })
    })

    it("includes sub-agent summaries", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          subAgentActivity: [{
            agentId: "agent-abc",
            agentName: "researcher",
            subagentType: "Explore",
            type: "assistant",
            content: [],
            toolCalls: [],
            thinking: [],
            text: ["Found files"],
            timestamp: "",
            tokenUsage: null,
            model: null,
            isBackground: false,
            status: "success",
            durationMs: 5000,
            toolUseCount: 3,
          }],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.turns[0].subAgents).toHaveLength(1)
      expect(data.turns[0].subAgents[0]).toEqual({
        agentId: "agent-abc",
        name: "researcher",
        type: "Explore",
        status: "success",
        durationMs: 5000,
        toolUseCount: 3,
        isBackground: false,
      })
    })

    it("deduplicates sub-agents by agentId, keeping the last entry", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      const baseMsg = {
        type: "assistant" as const,
        content: [],
        toolCalls: [],
        thinking: [],
        timestamp: "",
        tokenUsage: null,
        model: null,
        isBackground: false,
      }
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          subAgentActivity: [
            { ...baseMsg, agentId: "dup-agent", agentName: null, subagentType: "Explore", text: ["progress 1"], status: undefined, durationMs: undefined, toolUseCount: undefined },
            { ...baseMsg, agentId: "dup-agent", agentName: null, subagentType: "Explore", text: ["progress 2"], status: undefined, durationMs: undefined, toolUseCount: undefined },
            { ...baseMsg, agentId: "dup-agent", agentName: "scout", subagentType: "Explore", text: ["done"], status: "success", durationMs: 8000, toolUseCount: 5 },
          ],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.turns[0].subAgents).toHaveLength(1)
      expect(data.turns[0].subAgents[0]).toEqual({
        agentId: "dup-agent",
        name: "scout",
        type: "Explore",
        status: "success",
        durationMs: 8000,
        toolUseCount: 5,
        isBackground: false,
      })
    })

    it("defaults optional sub-agent fields to null", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          subAgentActivity: [{
            agentId: "agent-old",
            agentName: null,
            subagentType: null,
            type: "assistant",
            content: [],
            toolCalls: [],
            thinking: [],
            text: [],
            timestamp: "",
            tokenUsage: null,
            model: null,
            isBackground: false,
            // No status, durationMs, toolUseCount (old format)
          }],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      const agent = data.turns[0].subAgents[0]
      expect(agent.name).toBeNull()
      expect(agent.type).toBeNull()
      expect(agent.status).toBeNull()
      expect(agent.durationMs).toBeNull()
      expect(agent.toolUseCount).toBeNull()
    })

    it("detects compacted sessions", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [
          makeTurn({ compactionSummary: "2 turns compacted" }),
          makeTurn(),
        ],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.compacted).toBe(true)
      expect(data.turns[0].compactionSummary).toBe("2 turns compacted")
      expect(data.turns[1].compactionSummary).toBeNull()
    })

    it("reshapes stats correctly", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        stats: {
          totalInputTokens: 10000,
          totalOutputTokens: 3000,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalCostUSD: 0.1,
          toolCallCounts: { Read: 5, Edit: 2 },
          errorCount: 1,
          totalDurationMs: 10000,
          turnCount: 3,
        },
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.stats).toEqual({
        totalTurns: 3,
        totalToolCalls: 7,
        totalTokens: { input: 10000, output: 3000 },
      })
    })

    it("includes branchedFrom when present", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        branchedFrom: { sessionId: "parent-abc", turnIndex: 3 },
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.branchedFrom).toEqual({ sessionId: "parent-abc", turnIndex: 3 })
    })

    it("sets hasThinking correctly", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          thinking: [{ type: "thinking", thinking: "Let me think...", signature: "sig" }],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.turns[0].hasThinking).toBe(true)
    })

    it("detects isError from tool calls", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          toolCalls: [
            { id: "tc1", name: "Edit", input: {}, result: "failed", isError: true, timestamp: "" },
          ],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.turns[0].isError).toBe(true)
    })
  })

  // ── L2: Turn Detail ──────────────────────────────────────────────────────

  describe("L2 — Turn Detail", () => {
    it("returns 400 for non-numeric turn index", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession())

      const { req, res, next } = createMockReqRes("GET", "/test-session/turn/abc")
      await handler(req as never, res as never, next)
      expect(res._getStatus()).toBe(400)
      expect(JSON.parse(res._getData())).toMatchObject({ error: "Invalid turn index" })
    })

    it("returns 404 for out-of-range turn index", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession())

      const { req, res, next } = createMockReqRes("GET", "/test-session/turn/99")
      await handler(req as never, res as never, next)
      expect(res._getStatus()).toBe(404)
      expect(JSON.parse(res._getData())).toMatchObject({ error: "Turn not found" })
    })

    it("returns turn detail with content blocks", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          contentBlocks: [
            {
              kind: "thinking",
              blocks: [
                { type: "thinking", thinking: "Analyzing...", signature: "sig1" },
                { type: "thinking", thinking: "Found it.", signature: "sig2" },
              ],
              timestamp: "2026-03-02T10:00:01Z",
            },
            {
              kind: "text",
              text: ["Here is the fix."],
              timestamp: "2026-03-02T10:00:02Z",
            },
            {
              kind: "tool_calls",
              toolCalls: [
                { id: "tc1", name: "Edit", input: { file_path: "/a.ts" }, result: "done", isError: false, timestamp: "" },
              ],
              timestamp: "2026-03-02T10:00:03Z",
            },
          ],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session/turn/0")
      await handler(req as never, res as never, next)

      expect(res._getStatus()).toBe(200)
      const data = JSON.parse(res._getData())
      expect(data.sessionId).toBe("test-session-123")
      expect(data.turnIndex).toBe(0)
      expect(data.contentBlocks).toHaveLength(3)

      // Thinking: concatenated
      expect(data.contentBlocks[0].kind).toBe("thinking")
      expect(data.contentBlocks[0].text).toBe("Analyzing...\n\nFound it.")

      // Text
      expect(data.contentBlocks[1].kind).toBe("text")
      expect(data.contentBlocks[1].text).toBe("Here is the fix.")

      // Tool calls
      expect(data.contentBlocks[2].kind).toBe("tool_calls")
      expect(data.contentBlocks[2].toolCalls[0].name).toBe("Edit")
      expect(data.contentBlocks[2].toolCalls[0].resultTruncated).toBe(false)
    })

    it("truncates tool call results over 10K chars", async () => {
      const longResult = "x".repeat(15000)
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          contentBlocks: [{
            kind: "tool_calls",
            toolCalls: [{ id: "tc1", name: "Read", input: {}, result: longResult, isError: false, timestamp: "" }],
          }],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session/turn/0")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      const tc = data.contentBlocks[0].toolCalls[0]
      expect(tc.result.length).toBe(10000)
      expect(tc.resultTruncated).toBe(true)
    })

    it("handles null tool call result", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          contentBlocks: [{
            kind: "tool_calls",
            toolCalls: [{ id: "tc1", name: "Bash", input: {}, result: null, isError: false, timestamp: "" }],
          }],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session/turn/0")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      const tc = data.contentBlocks[0].toolCalls[0]
      expect(tc.result).toBeNull()
      expect(tc.resultTruncated).toBe(false)
    })

    it("filters out redacted thinking blocks", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          contentBlocks: [{
            kind: "thinking",
            blocks: [
              { type: "thinking", thinking: "Real thought", signature: "sig" },
              { type: "thinking", thinking: "", signature: "redacted-sig" }, // redacted
            ],
          }],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session/turn/0")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.contentBlocks[0].text).toBe("Real thought")
    })

    it("reshapes tokenUsage field names", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({ tokenUsage: makeTokenUsage(8000, 2500) })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session/turn/0")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      expect(data.tokenUsage).toEqual({ input: 8000, output: 2500 })
    })

    it("maps sub_agent content blocks with detail", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          contentBlocks: [{
            kind: "sub_agent",
            messages: [{
              agentId: "agent-xyz",
              agentName: "scout",
              subagentType: "Explore",
              type: "assistant",
              content: [],
              toolCalls: [],
              thinking: [],
              text: ["Found 3 files"],
              timestamp: "",
              tokenUsage: null,
              model: null,
              isBackground: false,
              prompt: "Find test files",
              status: "success",
              durationMs: 3000,
              toolUseCount: 5,
            }],
          }],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session/turn/0")
      await handler(req as never, res as never, next)

      const data = JSON.parse(res._getData())
      const agent = data.contentBlocks[0].agents[0]
      expect(agent.agentId).toBe("agent-xyz")
      expect(agent.prompt).toBe("Find test files")
      expect(agent.resultText).toBe("Found 3 files")
      expect(agent.status).toBe("success")
    })
  })

  // ── L3: Sub-Agent Detail ─────────────────────────────────────────────────

  describe("L3 — Sub-Agent Detail", () => {
    it("returns 404 when agent not found", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession())
      mockedReaddir.mockResolvedValueOnce([] as never)

      const { req, res, next } = createMockReqRes("GET", "/test-session/agent/nonexistent")
      await handler(req as never, res as never, next)

      expect(res._getStatus()).toBe(404)
      expect(JSON.parse(res._getData())).toMatchObject({ error: "Agent not found" })
    })

    it("returns sub-agent overview with L1 shape", async () => {
      // Parent session
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never) // parent jsonl
      const parentSession = makeSession({
        turns: [makeTurn({
          subAgentActivity: [{
            agentId: "abc123",
            agentName: "scout",
            subagentType: "Explore",
            type: "assistant",
            content: [],
            toolCalls: [],
            thinking: [],
            text: [],
            timestamp: "",
            tokenUsage: null,
            model: null,
            isBackground: false,
          }],
          toolCalls: [
            { id: "tc-agent", name: "Agent", input: { prompt: "search" }, result: "done", isError: false, timestamp: "" },
          ],
        })],
      })
      mockedParseSession.mockReturnValueOnce(parentSession)

      // Subagent file lookup
      mockedReaddir.mockResolvedValueOnce(["agent-abc123.jsonl"] as never)

      // Subagent session
      mockedReadFile.mockResolvedValueOnce("" as never) // subagent jsonl
      const subagentSession = makeSession({
        sessionId: "sub-session",
        turns: [makeTurn({ userMessage: "search for auth files" })],
      })
      mockedParseSession.mockReturnValueOnce(subagentSession)

      // Team lookup (no teams dir)
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      const { req, res, next } = createMockReqRes("GET", "/test-session/agent/abc123")
      await handler(req as never, res as never, next)

      expect(res._getStatus()).toBe(200)
      const data = JSON.parse(res._getData())
      expect(data.agentId).toBe("abc123")
      expect(data.name).toBe("scout")
      expect(data.type).toBe("Explore")
      expect(data.isBackground).toBe(false)
      expect(data.teamContext).toBeNull()
      expect(data.overview.turns).toHaveLength(1)
      expect(data.overview.turns[0].userMessage).toBe("search for auth files")
    })

    it("returns sub-agent turn detail (L3+L2)", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession())
      mockedReaddir.mockResolvedValueOnce(["agent-abc123.jsonl"] as never)
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession({
        turns: [makeTurn({
          contentBlocks: [{
            kind: "text",
            text: ["Sub-agent response"],
          }],
        })],
      }))

      const { req, res, next } = createMockReqRes("GET", "/test-session/agent/abc123/turn/0")
      await handler(req as never, res as never, next)

      expect(res._getStatus()).toBe(200)
      const data = JSON.parse(res._getData())
      expect(data.turnIndex).toBe(0)
      expect(data.contentBlocks[0].text).toBe("Sub-agent response")
    })

    it("returns 400 for non-numeric sub-agent turn index", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession())
      mockedReaddir.mockResolvedValueOnce(["agent-abc123.jsonl"] as never)
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession())

      const { req, res, next } = createMockReqRes("GET", "/test-session/agent/abc123/turn/xyz")
      await handler(req as never, res as never, next)

      expect(res._getStatus()).toBe(400)
    })

    it("handles subagents directory not existing", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession())
      mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

      const { req, res, next } = createMockReqRes("GET", "/test-session/agent/abc123")
      await handler(req as never, res as never, next)

      expect(res._getStatus()).toBe(404)
      expect(JSON.parse(res._getData())).toMatchObject({ error: "Agent not found" })
    })
  })

  // ── Error handling ───────────────────────────────────────────────────────

  describe("Error handling", () => {
    it("returns 500 on unexpected errors", async () => {
      mockedFindJsonlPath.mockRejectedValueOnce(new Error("Disk failure"))

      const { req, res, next } = createMockReqRes("GET", "/test-session")
      await handler(req as never, res as never, next)

      expect(res._getStatus()).toBe(500)
      expect(JSON.parse(res._getData())).toMatchObject({ error: "Error: Disk failure" })
    })

    it("calls next for unknown path shapes", async () => {
      mockedFindJsonlPath.mockResolvedValueOnce("/path/to/session.jsonl")
      mockedReadFile.mockResolvedValueOnce("" as never)
      mockedParseSession.mockReturnValueOnce(makeSession())

      const { req, res, next } = createMockReqRes("GET", "/test-session/unknown/path/shape")
      await handler(req as never, res as never, next)

      expect(next).toHaveBeenCalled()
    })
  })
})
