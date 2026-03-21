import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { SearchIndex } from "../../lib/search-index"

// Mock dirs.PROJECTS_DIR to point at our temp directory.
// Use a mutable object so updates in beforeEach are visible through the
// captured import reference.
let tmpDir: string
const mockDirs = { PROJECTS_DIR: "", TEAMS_DIR: "", TASKS_DIR: "" }
const mockDbPath = { value: "" }

mock.module("../../lib/dirs", () => ({
  dirs: mockDirs,
  get DEFAULT_DB_PATH() {
    return mockDbPath.value
  },
}))

// Import after mock setup
import { searchSessions } from "../../commands/search"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a minimal JSONL session file with user + assistant turns. */
function writeSession(
  dir: string,
  filename: string,
  opts: {
    sessionId?: string
    userMessage?: string
    assistantMessage?: string
  } = {},
): string {
  const filePath = join(dir, filename)
  const lines = [
    JSON.stringify({
      type: "system",
      sessionId: opts.sessionId ?? filename.replace(".jsonl", ""),
      cwd: "/test/project",
    }),
    JSON.stringify({
      type: "user",
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: opts.userMessage ?? "Hello, world",
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: opts.assistantMessage ?? "I can help with that." }],
        model: "claude-sonnet-4-20250514",
        id: "msg_test",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }),
  ]
  writeFileSync(filePath, lines.join("\n"))
  return filePath
}

/** Create a session with tool calls for richer search testing. */
function writeSessionWithToolCalls(
  dir: string,
  filename: string,
  opts: {
    sessionId?: string
    userMessage?: string
    toolName?: string
    toolInput?: Record<string, unknown>
    toolResult?: string
  } = {},
): string {
  const filePath = join(dir, filename)
  const toolUseId = "toolu_test_123"
  const lines = [
    JSON.stringify({
      type: "system",
      sessionId: opts.sessionId ?? filename.replace(".jsonl", ""),
      cwd: "/test/project",
    }),
    JSON.stringify({
      type: "user",
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: opts.userMessage ?? "Run the tool",
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me use a tool." },
          {
            type: "tool_use",
            id: toolUseId,
            name: opts.toolName ?? "Read",
            input: opts.toolInput ?? { file_path: "/test/file.ts" },
          },
        ],
        model: "claude-sonnet-4-20250514",
        id: "msg_test",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId,
            content: opts.toolResult ?? "File contents here",
            is_error: false,
          },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done processing." }],
        model: "claude-sonnet-4-20250514",
        id: "msg_test2",
        stop_reason: "end_turn",
        usage: { input_tokens: 200, output_tokens: 100 },
      },
    }),
  ]
  writeFileSync(filePath, lines.join("\n"))
  return filePath
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("search command", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-search-test-"))
    const projectsDir = join(tmpDir, "projects")
    mkdirSync(projectsDir, { recursive: true })
    mockDirs.PROJECTS_DIR = projectsDir
    mockDirs.TEAMS_DIR = join(mockDirs.PROJECTS_DIR, "..", "teams")
    mockDirs.TASKS_DIR = join(mockDirs.PROJECTS_DIR, "..", "tasks")
    mockDbPath.value = join(mockDirs.PROJECTS_DIR, "..", "nonexistent-search-index.db")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Validation ───────────────────────────────────────────────────────────

  describe("validation", () => {
    it("rejects query shorter than 2 chars", async () => {
      const result = await searchSessions("x", {})
      expect(result).toHaveProperty("error")
      expect((result as { error: string }).error).toContain("at least 2 characters")
    })

    it("rejects empty query", async () => {
      const result = await searchSessions("", {})
      expect(result).toHaveProperty("error")
    })
  })

  // ── Response shape ───────────────────────────────────────────────────────

  describe("response shape", () => {
    it("returns expected response shape for no-match query", async () => {
      const result = await searchSessions("nonexistent-query-xyz99", {})
      expect(result).not.toHaveProperty("error")
      const resp = result as { query: string; totalHits: number; returnedHits: number; results: unknown[] }
      expect(resp.query).toBe("nonexistent-query-xyz99")
      expect(resp.totalHits).toBe(0)
      expect(resp.returnedHits).toBe(0)
      expect(Array.isArray(resp.results)).toBe(true)
      expect(resp.results.length).toBe(0)
    })

    it("returns expected response shape when sessions exist", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "test-sess.jsonl", { userMessage: "find authentication bugs" })

      const result = await searchSessions("authentication", { maxAge: "1d" })
      expect(result).not.toHaveProperty("error")
      const resp = result as {
        query: string
        totalHits: number
        returnedHits: number
        sessionsSearched: number
        results: Array<{ sessionId: string; hits: Array<{ location: string; snippet: string; matchCount: number }> }>
      }
      expect(resp.query).toBe("authentication")
      expect(resp.totalHits).toBeGreaterThan(0)
      expect(resp.returnedHits).toBeGreaterThan(0)
      expect(resp.sessionsSearched).toBeGreaterThan(0)
      expect(resp.results.length).toBeGreaterThan(0)

      const firstResult = resp.results[0]
      expect(firstResult).toHaveProperty("sessionId")
      expect(firstResult).toHaveProperty("hits")
      expect(firstResult.hits.length).toBeGreaterThan(0)

      const firstHit = firstResult.hits[0]
      expect(firstHit).toHaveProperty("location")
      expect(firstHit).toHaveProperty("snippet")
      expect(firstHit).toHaveProperty("matchCount")
      expect(firstHit.matchCount).toBeGreaterThan(0)
    })
  })

  // ── Raw-scan fallback (3-phase) ──────────────────────────────────────────

  describe("raw-scan fallback", () => {
    it("finds matches in user messages", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "s1.jsonl", { userMessage: "explain the database schema" })

      const result = await searchSessions("database schema", { maxAge: "1d" })
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ hits: Array<{ location: string }> }> }
      expect(resp.results.length).toBe(1)
      const userHit = resp.results[0].hits.find(h => h.location.includes("userMessage"))
      expect(userHit).toBeDefined()
    })

    it("finds matches in assistant messages", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "s1.jsonl", { assistantMessage: "The authentication layer uses JWT tokens." })

      const result = await searchSessions("JWT tokens", { maxAge: "1d" })
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ hits: Array<{ location: string }> }> }
      expect(resp.results.length).toBe(1)
      const assistantHit = resp.results[0].hits.find(h => h.location.includes("assistantMessage"))
      expect(assistantHit).toBeDefined()
    })

    it("finds matches in tool call inputs", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSessionWithToolCalls(projDir, "s1.jsonl", {
        toolName: "Read",
        toolInput: { file_path: "/src/authentication.ts" },
      })

      const result = await searchSessions("authentication.ts", { maxAge: "1d" }, null)
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ hits: Array<{ location: string; toolName?: string }> }> }
      expect(resp.results.length).toBe(1)
      const toolHit = resp.results[0].hits.find(h => h.location.includes("toolCall") && h.location.includes("input"))
      expect(toolHit).toBeDefined()
      expect(toolHit!.toolName).toBe("Read")
    })

    it("finds matches in tool call results", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSessionWithToolCalls(projDir, "s1.jsonl", {
        toolResult: "export function validateCredentials() { return true }",
      })

      const result = await searchSessions("validateCredentials", { maxAge: "1d" })
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ hits: Array<{ location: string }> }> }
      expect(resp.results.length).toBe(1)
      const resultHit = resp.results[0].hits.find(h => h.location.includes("toolCall") && h.location.includes("result"))
      expect(resultHit).toBeDefined()
    })

    it("searches across multiple sessions", async () => {
      const proj1 = join(mockDirs.PROJECTS_DIR, "-proj-one")
      const proj2 = join(mockDirs.PROJECTS_DIR, "-proj-two")
      mkdirSync(proj1, { recursive: true })
      mkdirSync(proj2, { recursive: true })

      writeSession(proj1, "s1.jsonl", { userMessage: "unique-search-keyword here" })
      writeSession(proj2, "s2.jsonl", { userMessage: "also has unique-search-keyword" })

      const result = await searchSessions("unique-search-keyword", { maxAge: "1d" })
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ sessionId: string }> }
      expect(resp.results.length).toBe(2)
    })

    it("respects the limit parameter", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })

      // Create sessions that all match
      for (let i = 0; i < 5; i++) {
        writeSession(projDir, `s${i}.jsonl`, { userMessage: `searchable-term in session ${i}` })
      }

      const result = await searchSessions("searchable-term", { limit: 2, maxAge: "1d" })
      expect(result).not.toHaveProperty("error")
      const resp = result as { returnedHits: number }
      expect(resp.returnedHits).toBeLessThanOrEqual(2)
    })

    it("respects case sensitivity", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "s1.jsonl", { userMessage: "CamelCaseWord in this message" })

      // Case insensitive (default) — should match
      const result1 = await searchSessions("camelcaseword", { maxAge: "1d" })
      expect(result1).not.toHaveProperty("error")
      expect((result1 as { results: unknown[] }).results.length).toBe(1)

      // Case sensitive — should not match lowercase query
      const result2 = await searchSessions("camelcaseword", { caseSensitive: true, maxAge: "1d" })
      expect(result2).not.toHaveProperty("error")
      expect((result2 as { results: unknown[] }).results.length).toBe(0)

      // Case sensitive — exact match should work
      const result3 = await searchSessions("CamelCaseWord", { caseSensitive: true, maxAge: "1d" })
      expect(result3).not.toHaveProperty("error")
      expect((result3 as { results: unknown[] }).results.length).toBe(1)
    })

    it("skips the memory directory", async () => {
      const memDir = join(mockDirs.PROJECTS_DIR, "memory")
      mkdirSync(memDir, { recursive: true })
      writeSession(memDir, "should-be-skipped.jsonl", { userMessage: "memory-hidden-content" })

      const result = await searchSessions("memory-hidden-content", { maxAge: "1d" })
      expect(result).not.toHaveProperty("error")
      expect((result as { results: unknown[] }).results.length).toBe(0)
    })

    it("returns empty results when no sessions exist", async () => {
      const result = await searchSessions("anything", { maxAge: "1d" })
      expect(result).not.toHaveProperty("error")
      const resp = result as { totalHits: number; results: unknown[] }
      expect(resp.totalHits).toBe(0)
      expect(resp.results.length).toBe(0)
    })

    it("snippet is centered on the match", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      const longMessage = "A".repeat(200) + " NEEDLE " + "B".repeat(200)
      writeSession(projDir, "s1.jsonl", { userMessage: longMessage })

      const result = await searchSessions("NEEDLE", { maxAge: "1d" }, null)
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ hits: Array<{ snippet: string }> }> }
      expect(resp.results.length).toBe(1)
      const snippet = resp.results[0].hits[0].snippet
      expect(snippet).toContain("NEEDLE")
      // Should have ellipsis since we're in the middle of a long string
      expect(snippet.startsWith("...")).toBe(true)
      expect(snippet.endsWith("...")).toBe(true)
    })

    it("counts multiple matches correctly", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "s1.jsonl", {
        userMessage: "alpha beta alpha gamma alpha",
      })

      const result = await searchSessions("alpha", { maxAge: "1d" }, null)
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ hits: Array<{ matchCount: number }> }> }
      expect(resp.results.length).toBe(1)
      const userHit = resp.results[0].hits.find(h => h.matchCount >= 3)
      expect(userHit).toBeDefined()
    })
  })

  // ── FTS5 fast path ───────────────────────────────────────────────────────

  describe("FTS5 fast path", () => {
    it("uses provided SearchIndex directly", async () => {
      const dbPath = join(tmpDir, "test-search.db")
      const index = new SearchIndex(dbPath)

      // Populate the index with a session file
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      const sessionFile = writeSession(projDir, "fts-test.jsonl", {
        userMessage: "unique-fts-keyword here",
      })
      index.indexFile(sessionFile)

      const result = await searchSessions("unique-fts-keyword", {}, index)
      expect(result).not.toHaveProperty("error")
      const resp = result as { totalHits: number; results: Array<{ sessionId: string }> }
      expect(resp.totalHits).toBeGreaterThan(0)
      expect(resp.results.length).toBeGreaterThan(0)

      index.close()
    })

    it("groups FTS5 results by sessionId", async () => {
      const dbPath = join(tmpDir, "test-search.db")
      const index = new SearchIndex(dbPath)

      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })

      // Create two sessions both containing the keyword
      writeSession(projDir, "sess-a.jsonl", { userMessage: "common-fts-term in session A" })
      writeSession(projDir, "sess-b.jsonl", { userMessage: "common-fts-term in session B" })

      index.buildFull(mockDirs.PROJECTS_DIR)

      const result = await searchSessions("common-fts-term", {}, index)
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ sessionId: string; hits: unknown[] }> }
      expect(resp.results.length).toBe(2)

      const sessionIds = resp.results.map(r => r.sessionId).sort()
      expect(sessionIds).toContain("sess-a")
      expect(sessionIds).toContain("sess-b")

      index.close()
    })

    it("respects limit in FTS5 path", async () => {
      const dbPath = join(tmpDir, "test-search.db")
      const index = new SearchIndex(dbPath)

      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })

      for (let i = 0; i < 5; i++) {
        writeSession(projDir, `fts-s${i}.jsonl`, { userMessage: `fts-limit-test content ${i}` })
      }
      index.buildFull(mockDirs.PROJECTS_DIR)

      const result = await searchSessions("fts-limit-test", { limit: 2 }, index)
      expect(result).not.toHaveProperty("error")
      const resp = result as { returnedHits: number }
      expect(resp.returnedHits).toBeLessThanOrEqual(2)

      index.close()
    })

    it("respects sessionId filter in FTS5 path", async () => {
      const dbPath = join(tmpDir, "test-search.db")
      const index = new SearchIndex(dbPath)

      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })

      writeSession(projDir, "target-sess.jsonl", { userMessage: "fts-session-filter content" })
      writeSession(projDir, "other-sess.jsonl", { userMessage: "fts-session-filter content" })

      index.buildFull(mockDirs.PROJECTS_DIR)

      const result = await searchSessions("fts-session-filter", { sessionId: "target-sess" }, index)
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ sessionId: string }> }
      expect(resp.results.length).toBe(1)
      expect(resp.results[0].sessionId).toBe("target-sess")

      index.close()
    })

    it("falls back to raw scan when SearchIndex is null", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "fallback.jsonl", { userMessage: "raw-scan-fallback-keyword" })

      // Explicitly pass null — should use raw scan
      const result = await searchSessions("raw-scan-fallback-keyword", { maxAge: "1d" }, null)
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ sessionId: string }> }
      expect(resp.results.length).toBe(1)
    })
  })

  // ── Subagent files ───────────────────────────────────────────────────────

  describe("subagent search", () => {
    it("searches subagent JSONL files when parent also matches", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })

      // Parent session — must also contain the search term for Phase 2
      // pre-filter to pass (raw text match on parent file is required
      // before subagent files are walked).
      writeSession(projDir, "parent.jsonl", {
        userMessage: "start the task with subagent-keyword",
      })

      // Subagent directory: parent/subagents/agent-abc.jsonl
      const subDir = join(projDir, "parent", "subagents")
      mkdirSync(subDir, { recursive: true })
      writeSession(subDir, "agent-abc.jsonl", {
        userMessage: "subagent-keyword used deeper in the agent",
      })

      const result = await searchSessions("subagent-keyword", { maxAge: "1d", depth: 2 }, null)
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: Array<{ hits: Array<{ location: string }> }> }
      // The parent session should match, plus subagent hits should be included
      expect(resp.results.length).toBeGreaterThan(0)
      const agentHit = resp.results[0].hits.find(h => h.location.includes("agent/"))
      expect(agentHit).toBeDefined()
    })

    it("does not find subagent-only matches when parent does not match", async () => {
      const projDir = join(mockDirs.PROJECTS_DIR, "-test-project")
      mkdirSync(projDir, { recursive: true })

      // Parent session does NOT contain the search term
      writeSession(projDir, "parent2.jsonl", { userMessage: "unrelated content" })

      // Subagent file contains the search term
      const subDir = join(projDir, "parent2", "subagents")
      mkdirSync(subDir, { recursive: true })
      writeSession(subDir, "agent-xyz.jsonl", {
        userMessage: "orphaned-subagent-term only here",
      })

      // Raw-scan pre-filters on the parent file, so this should not match
      const result = await searchSessions("orphaned-subagent-term", { maxAge: "1d", depth: 2 }, null)
      expect(result).not.toHaveProperty("error")
      const resp = result as { results: unknown[] }
      expect(resp.results.length).toBe(0)
    })
  })
})
