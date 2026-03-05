// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Mock dirs.PROJECTS_DIR (and TEAMS_DIR / TASKS_DIR) to point at temp directories.
let tmpDir: string
let projectsDir: string

vi.mock("../../lib/dirs", () => ({
  get dirs() {
    return {
      PROJECTS_DIR: projectsDir,
      TEAMS_DIR: join(projectsDir, "..", "teams"),
      TASKS_DIR: join(projectsDir, "..", "tasks"),
    }
  },
}))

// Import after mock setup
import {
  getSessionOverview,
  getTurnDetail,
  getAgentOverview,
  getAgentTurnDetail,
} from "../../commands/context"

/** Helper: build a minimal JSONL session with N user/assistant turn-pairs. */
function buildSessionLines(
  opts: {
    sessionId?: string
    cwd?: string
    model?: string
    turns?: Array<{ userMessage: string; assistantMessage: string }>
  } = {},
): string {
  const lines: string[] = []

  // System line
  lines.push(
    JSON.stringify({
      type: "system",
      sessionId: opts.sessionId ?? "test-session",
      cwd: opts.cwd ?? "/test/project",
      gitBranch: "main",
    }),
  )

  const turns = opts.turns ?? [
    { userMessage: "Hello, world", assistantMessage: "I can help with that." },
  ]

  for (const turn of turns) {
    lines.push(
      JSON.stringify({
        type: "user",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: turn.userMessage },
      }),
    )
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: turn.assistantMessage }],
          model: opts.model ?? "claude-sonnet-4-20250514",
          id: "msg_" + Math.random().toString(36).slice(2, 8),
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }),
    )
  }

  return lines.join("\n")
}

/** Helper: write a session file in a project directory. */
function writeSession(
  dir: string,
  filename: string,
  content: string,
): string {
  const filePath = join(dir, filename)
  writeFileSync(filePath, content)
  return filePath
}

describe("context command", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-context-test-"))
    projectsDir = join(tmpDir, "projects")
    mkdirSync(projectsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -- getSessionOverview (L1) ------------------------------------------------

  describe("getSessionOverview", () => {
    it("returns error for nonexistent session", async () => {
      const result = await getSessionOverview("nonexistent-session-id-99999")
      expect(result).toHaveProperty("error", "Session not found")
    })

    it("returns overview for a valid session", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      const content = buildSessionLines({
        sessionId: "ctx-test",
        turns: [
          { userMessage: "What does this code do?", assistantMessage: "It handles authentication." },
          { userMessage: "Can you refactor it?", assistantMessage: "Sure, here is the refactored version." },
        ],
      })
      writeSession(projDir, "ctx-test.jsonl", content)

      const result = await getSessionOverview("ctx-test") as any
      expect(result).not.toHaveProperty("error")
      expect(result).toHaveProperty("sessionId", "ctx-test")
      expect(result).toHaveProperty("turns")
      expect(Array.isArray(result.turns)).toBe(true)
      expect(result.turns.length).toBe(2)
      expect(result).toHaveProperty("stats")
      expect(result.stats).toHaveProperty("totalTurns", 2)
    })

    it("includes turn summaries with expected shape", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      const content = buildSessionLines({
        sessionId: "shape-test",
        turns: [{ userMessage: "Hello", assistantMessage: "Hi there" }],
      })
      writeSession(projDir, "shape-test.jsonl", content)

      const result = await getSessionOverview("shape-test") as any
      const turn = result.turns[0]

      expect(turn).toHaveProperty("turnIndex", 0)
      expect(turn).toHaveProperty("userMessage")
      expect(turn).toHaveProperty("assistantMessage")
      expect(turn).toHaveProperty("toolSummary")
      expect(turn).toHaveProperty("subAgents")
      expect(turn).toHaveProperty("hasThinking")
      expect(turn).toHaveProperty("isError")
      expect(turn).toHaveProperty("compactionSummary")
    })
  })

  // -- getTurnDetail (L2) -----------------------------------------------------

  describe("getTurnDetail", () => {
    it("returns error for nonexistent session", async () => {
      const result = await getTurnDetail("nonexistent-session-id-99999", 0)
      expect(result).toHaveProperty("error", "Session not found")
    })

    it("returns error for out-of-range turn index", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      const content = buildSessionLines({ sessionId: "range-test" })
      writeSession(projDir, "range-test.jsonl", content)

      const result = await getTurnDetail("range-test", 999)
      expect(result).toHaveProperty("error", "Turn not found")
    })

    it("returns error for negative turn index", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      const content = buildSessionLines({ sessionId: "neg-test" })
      writeSession(projDir, "neg-test.jsonl", content)

      const result = await getTurnDetail("neg-test", -1)
      expect(result).toHaveProperty("error", "Turn not found")
    })

    it("returns detail for a valid turn", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      const content = buildSessionLines({
        sessionId: "detail-test",
        turns: [
          { userMessage: "Explain the architecture", assistantMessage: "The system uses a modular design." },
          { userMessage: "Show me the code", assistantMessage: "Here is the main module." },
        ],
      })
      writeSession(projDir, "detail-test.jsonl", content)

      const result = await getTurnDetail("detail-test", 1) as any
      expect(result).not.toHaveProperty("error")
      expect(result).toHaveProperty("sessionId", "detail-test")
      expect(result).toHaveProperty("turnIndex", 1)
      expect(result).toHaveProperty("userMessage", "Show me the code")
      expect(result).toHaveProperty("contentBlocks")
      expect(Array.isArray(result.contentBlocks)).toBe(true)
    })

    it("includes token usage when available", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      const content = buildSessionLines({
        sessionId: "token-test",
        turns: [{ userMessage: "Hello", assistantMessage: "Hi" }],
      })
      writeSession(projDir, "token-test.jsonl", content)

      const result = await getTurnDetail("token-test", 0) as any
      expect(result).toHaveProperty("tokenUsage")
      if (result.tokenUsage) {
        expect(result.tokenUsage).toHaveProperty("input")
        expect(result.tokenUsage).toHaveProperty("output")
      }
    })
  })

  // -- getAgentOverview (L3) --------------------------------------------------

  describe("getAgentOverview", () => {
    it("returns error for nonexistent session", async () => {
      const result = await getAgentOverview("nonexistent-session-id-99999", "fake-agent")
      expect(result).toHaveProperty("error", "Session not found")
    })

    it("returns error when agent not found", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      const content = buildSessionLines({ sessionId: "agent-miss" })
      writeSession(projDir, "agent-miss.jsonl", content)

      const result = await getAgentOverview("agent-miss", "nonexistent-agent-id")
      expect(result).toHaveProperty("error", "Agent not found")
    })

    it("returns agent overview when sub-agent file exists", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      // Create parent session
      const content = buildSessionLines({ sessionId: "parent-session" })
      writeSession(projDir, "parent-session.jsonl", content)

      // Create sub-agent directory and file
      const subagentsDir = join(projDir, "parent-session", "subagents")
      mkdirSync(subagentsDir, { recursive: true })

      const agentContent = buildSessionLines({
        sessionId: "agent-abc123",
        turns: [
          { userMessage: "Research the topic", assistantMessage: "I found relevant information." },
        ],
      })
      writeFileSync(join(subagentsDir, "agent-abc123.jsonl"), agentContent)

      const result = await getAgentOverview("parent-session", "abc123") as any
      expect(result).not.toHaveProperty("error")
      expect(result).toHaveProperty("sessionId", "parent-session")
      expect(result).toHaveProperty("agentId", "abc123")
      expect(result).toHaveProperty("overview")
      expect(result.overview).toHaveProperty("turns")
      expect(result.overview.turns.length).toBe(1)
    })
  })

  // -- getAgentTurnDetail (L3+L2) ---------------------------------------------

  describe("getAgentTurnDetail", () => {
    it("returns error for nonexistent session", async () => {
      const result = await getAgentTurnDetail("nonexistent-session-id-99999", "fake-agent", 0)
      expect(result).toHaveProperty("error", "Session not found")
    })

    it("returns error when agent not found", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      const content = buildSessionLines({ sessionId: "agent-turn-miss" })
      writeSession(projDir, "agent-turn-miss.jsonl", content)

      const result = await getAgentTurnDetail("agent-turn-miss", "nonexistent-agent", 0)
      expect(result).toHaveProperty("error", "Agent not found")
    })

    it("returns error for out-of-range agent turn index", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      const content = buildSessionLines({ sessionId: "agent-range" })
      writeSession(projDir, "agent-range.jsonl", content)

      // Create sub-agent
      const subagentsDir = join(projDir, "agent-range", "subagents")
      mkdirSync(subagentsDir, { recursive: true })
      const agentContent = buildSessionLines({
        sessionId: "sub-agent",
        turns: [{ userMessage: "Do something", assistantMessage: "Done." }],
      })
      writeFileSync(join(subagentsDir, "agent-sub1.jsonl"), agentContent)

      const result = await getAgentTurnDetail("agent-range", "sub1", 999)
      expect(result).toHaveProperty("error", "Turn not found")
    })

    it("returns agent turn detail for valid indices", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })

      const content = buildSessionLines({ sessionId: "agent-detail" })
      writeSession(projDir, "agent-detail.jsonl", content)

      // Create sub-agent with multiple turns
      const subagentsDir = join(projDir, "agent-detail", "subagents")
      mkdirSync(subagentsDir, { recursive: true })
      const agentContent = buildSessionLines({
        sessionId: "agent-detail-sub",
        turns: [
          { userMessage: "First task", assistantMessage: "Completed first task." },
          { userMessage: "Second task", assistantMessage: "Completed second task." },
        ],
      })
      writeFileSync(join(subagentsDir, "agent-myagent.jsonl"), agentContent)

      const result = await getAgentTurnDetail("agent-detail", "myagent", 1) as any
      expect(result).not.toHaveProperty("error")
      expect(result).toHaveProperty("turnIndex", 1)
      expect(result).toHaveProperty("userMessage", "Second task")
      expect(result).toHaveProperty("contentBlocks")
    })
  })
})
