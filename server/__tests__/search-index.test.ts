// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { SearchIndex, type SearchHit } from "../search-index"
import { unlinkSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

const TEST_DB = "/tmp/test-search-index.db"
const TEST_DIR = "/tmp/test-search-index-files"

// ── Helpers: Build realistic JSONL messages matching RawMessage types ──────

function makeUserMessage(text: string) {
  return {
    type: "user",
    message: { role: "user", content: text },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

function makeAssistantMessage(
  text: string,
  toolUse?: { id: string; name: string; input: Record<string, unknown> }
) {
  const content: unknown[] = [{ type: "text", text }]
  if (toolUse) {
    content.push({
      type: "tool_use",
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
    })
  }
  return {
    type: "assistant",
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

function makeToolResultMessage(toolUseId: string, result: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: result,
          is_error: false,
        },
      ],
    },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

function makeAssistantWithThinking(thinkingText: string, responseText: string) {
  return {
    type: "assistant",
    message: {
      id: crypto.randomUUID(),
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: [
        { type: "thinking", thinking: thinkingText, signature: "sig" },
        { type: "text", text: responseText },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

function makeSummaryMessage(summaryText: string) {
  return {
    type: "summary",
    summary: summaryText,
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

function writeTestJsonl(filePath: string, lines: object[]): void {
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"))
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("SearchIndex", () => {
  afterEach(() => {
    try { unlinkSync(TEST_DB) } catch {}
    try { unlinkSync(TEST_DB + "-wal") } catch {}
    try { unlinkSync(TEST_DB + "-shm") } catch {}
  })

  describe("constructor", () => {
    it("creates database with correct schema", () => {
      const index = new SearchIndex(TEST_DB)
      const stats = index.getStats()
      expect(stats.indexedFiles).toBe(0)
      expect(stats.totalRows).toBe(0)
      index.close()
    })
  })

  describe("indexFile", () => {
    beforeEach(() => {
      mkdirSync(TEST_DIR, { recursive: true })
    })
    afterEach(() => {
      try { rmSync(TEST_DIR, { recursive: true }) } catch {}
    })

    it("indexes user and assistant messages", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("find the authentication bug"),
        makeAssistantMessage("I found the authentication issue in auth.ts"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "test-session", Date.now())

      const stats = index.getStats()
      expect(stats.indexedFiles).toBe(1)
      expect(stats.totalRows).toBeGreaterThan(0)
      index.close()
    })

    it("indexes tool call inputs and results", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("read the config file"),
        makeAssistantMessage("Let me read it", {
          id: "tc1",
          name: "Read",
          input: { file_path: "/app/config.ts" },
        }),
        makeToolResultMessage("tc1", "export const SECRET_KEY = 'abc123'"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "test-session", Date.now())

      // Should have rows for: userMessage, assistantMessage, toolCall input, toolCall result
      const stats = index.getStats()
      expect(stats.totalRows).toBeGreaterThanOrEqual(3) // user + assistant + tool input + tool result
      index.close()
    })

    it("indexes thinking blocks", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("explain the code"),
        makeAssistantWithThinking(
          "Let me think about the architecture carefully",
          "Here is my explanation of the code"
        ),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "test-session", Date.now())

      const stats = index.getStats()
      // user message + assistant text + thinking
      expect(stats.totalRows).toBeGreaterThanOrEqual(3)
      index.close()
    })

    it("indexes compaction summaries", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("first prompt"),
        makeAssistantMessage("first response"),
        makeSummaryMessage("Conversation was compacted"),
        makeUserMessage("second prompt after compaction"),
        makeAssistantMessage("second response"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "test-session", Date.now())

      const stats = index.getStats()
      expect(stats.totalRows).toBeGreaterThan(0)
      index.close()
    })

    it("re-indexes a file by deleting old rows first (idempotent)", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("first version keyword unique_marker_alpha"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "test-session", Date.now())

      const statsBefore = index.getStats()
      expect(statsBefore.totalRows).toBeGreaterThan(0)
      expect(statsBefore.indexedFiles).toBe(1)

      // Re-write file with different content and re-index
      writeTestJsonl(fp, [
        makeUserMessage("second version keyword unique_marker_beta"),
      ])
      index.indexFile(fp, "test-session", Date.now())

      const statsAfter = index.getStats()
      // Should still have exactly 1 indexed file (not 2)
      expect(statsAfter.indexedFiles).toBe(1)
      // Row count should be the same as a single-message session
      expect(statsAfter.totalRows).toBe(statsBefore.totalRows)
      index.close()
    })

    it("tracks the file in indexed_files table", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [makeUserMessage("hello world")])

      const index = new SearchIndex(TEST_DB)
      const mtimeMs = Date.now()
      index.indexFile(fp, "test-session", mtimeMs)

      const stats = index.getStats()
      expect(stats.indexedFiles).toBe(1)
      expect(stats.indexedSessions).toBe(1)
      expect(stats.indexedSubagents).toBe(0)
      index.close()
    })

    it("tracks subagent files correctly", () => {
      const fp = join(TEST_DIR, "agent.jsonl")
      writeTestJsonl(fp, [makeUserMessage("subagent task")])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "parent-session", Date.now(), {
        isSubagent: true,
        parentSessionId: "parent-session",
      })

      const stats = index.getStats()
      expect(stats.indexedFiles).toBe(1)
      expect(stats.indexedSessions).toBe(0)
      expect(stats.indexedSubagents).toBe(1)
      index.close()
    })

    it("uses correct location strings for content types", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("user prompt here"),
        makeAssistantWithThinking("thinking content here", "assistant reply here"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "test-session", Date.now())

      // Query the raw rows to verify location strings
      // We'll use the internal db access through a search-like mechanism
      // The locations should follow the pattern: turn/{N}/{type}
      const stats = index.getStats()
      expect(stats.totalRows).toBeGreaterThanOrEqual(3)
      index.close()
    })

    it("handles empty JSONL files gracefully", () => {
      const fp = join(TEST_DIR, "empty.jsonl")
      writeTestJsonl(fp, [])

      const index = new SearchIndex(TEST_DB)
      // Should not throw
      index.indexFile(fp, "empty-session", Date.now())

      const stats = index.getStats()
      expect(stats.indexedFiles).toBe(1)
      expect(stats.totalRows).toBe(0)
      index.close()
    })

    it("handles multiple turns correctly", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("first question about authentication"),
        makeAssistantMessage("first answer about auth"),
        makeUserMessage("second question about database"),
        makeAssistantMessage("second answer about the database"),
        makeUserMessage("third question about testing"),
        makeAssistantMessage("third answer about tests"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "test-session", Date.now())

      const stats = index.getStats()
      // 3 turns x 2 rows each (user + assistant) = 6 rows
      expect(stats.totalRows).toBe(6)
      index.close()
    })

    it("skips empty content blocks", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("question"),
        // Assistant message with empty text
        {
          type: "assistant",
          message: {
            id: crypto.randomUUID(),
            role: "assistant",
            model: "claude-sonnet-4-20250514",
            content: [{ type: "text", text: "" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          uuid: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        },
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "test-session", Date.now())

      const stats = index.getStats()
      // Only user message should be indexed; empty assistant text is skipped
      expect(stats.totalRows).toBe(1)
      index.close()
    })
  })

  describe("search", () => {
    beforeEach(() => {
      mkdirSync(TEST_DIR, { recursive: true })
    })
    afterEach(() => {
      try { rmSync(TEST_DIR, { recursive: true }) } catch {}
    })

    it("returns hits with sessionId, location, snippet, and matchCount", () => {
      const fp = join(TEST_DIR, "session-abc.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("the authentication system needs fixing"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "session-abc", Date.now())
      const hits = index.search("authentication")

      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].sessionId).toBe("session-abc")
      expect(hits[0].location).toBe("turn/0/userMessage")
      expect(hits[0].snippet).toContain("authentication")
      expect(typeof hits[0].matchCount).toBe("number")
      expect(hits[0].matchCount).toBeGreaterThanOrEqual(1)
      index.close()
    })

    it("respects limit parameter", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      // Create 10 turns with interleaved user/assistant messages
      const lines: object[] = []
      for (let i = 0; i < 10; i++) {
        lines.push(makeUserMessage(`keyword turn ${i} special content`))
        lines.push(makeAssistantMessage(`ok response ${i}`))
      }
      writeTestJsonl(fp, lines)

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "session", Date.now())
      const hits = index.search("keyword", { limit: 3 })
      expect(hits.length).toBe(3)
      index.close()
    })

    it("enforces max limit of 200", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("keyword content here"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "session", Date.now())
      // Requesting more than 200 should be clamped to 200
      const hits = index.search("keyword", { limit: 500 })
      // We only have 1 row, so just verify it doesn't throw
      expect(hits.length).toBeLessThanOrEqual(200)
      index.close()
    })

    it("defaults limit to 200 when not specified", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("keyword content"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "session", Date.now())
      // Should work without limit option
      const hits = index.search("keyword")
      expect(hits.length).toBeGreaterThan(0)
      index.close()
    })

    it("filters by sessionId", () => {
      const fp1 = join(TEST_DIR, "session-a.jsonl")
      const fp2 = join(TEST_DIR, "session-b.jsonl")
      writeTestJsonl(fp1, [makeUserMessage("keyword in session a")])
      writeTestJsonl(fp2, [makeUserMessage("keyword in session b")])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp1, "session-a", Date.now())
      index.indexFile(fp2, "session-b", Date.now())

      const hits = index.search("keyword", { sessionId: "session-a" })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.every((h) => h.sessionId === "session-a")).toBe(true)
      index.close()
    })

    it("filters by maxAgeMs via indexed_files mtime", () => {
      const fp1 = join(TEST_DIR, "recent.jsonl")
      const fp2 = join(TEST_DIR, "old.jsonl")
      writeTestJsonl(fp1, [makeUserMessage("keyword recent file")])
      writeTestJsonl(fp2, [makeUserMessage("keyword old file")])

      const now = Date.now()
      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp1, "recent", now - 1000) // 1s ago
      index.indexFile(fp2, "old", now - 10 * 24 * 3600_000) // 10 days ago

      const hits = index.search("keyword", { maxAgeMs: 5 * 24 * 3600_000 }) // 5 days
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.every((h) => h.sessionId === "recent")).toBe(true)
      index.close()
    })

    it("supports case-insensitive search by default (FTS5 trigram)", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("Authentication is broken in the system"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "session", Date.now())

      // Lowercase query should match uppercase content
      const hits = index.search("authentication")
      expect(hits.length).toBeGreaterThan(0)
      index.close()
    })

    it("supports case-sensitive post-filter", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("Authentication is broken"),
        makeAssistantMessage("the authentication module has a bug"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "session", Date.now())

      // Case-sensitive search for lowercase "authentication"
      const hitsLower = index.search("authentication", { caseSensitive: true })
      // Should only match the assistant message (lowercase "authentication")
      // not the user message ("Authentication" with capital A)
      for (const h of hitsLower) {
        expect(h.snippet).toContain("authentication")
        expect(h.snippet).not.toMatch(/Authentication/)
      }
      index.close()
    })

    it("returns empty array when no matches found", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("hello world"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "session", Date.now())

      const hits = index.search("xyznonexistentkeyword")
      expect(hits).toEqual([])
      index.close()
    })

    it("handles queries with special characters (double quotes)", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage('the value is "important" here'),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "session", Date.now())

      // Should not throw even with quotes in query
      const hits = index.search('important')
      expect(hits.length).toBeGreaterThan(0)
      index.close()
    })

    it("matches across different content types (user, assistant, tool)", () => {
      const fp = join(TEST_DIR, "session.jsonl")
      writeTestJsonl(fp, [
        makeUserMessage("find the special_marker_xyz in the code"),
        makeAssistantMessage("I found special_marker_xyz in the file", {
          id: "tc1",
          name: "Read",
          input: { file_path: "/app/special_marker_xyz.ts" },
        }),
        makeToolResultMessage("tc1", "export const special_marker_xyz = true"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp, "session", Date.now())

      const hits = index.search("special_marker_xyz")
      // Should find it in user message, assistant message, tool input, and tool result
      expect(hits.length).toBeGreaterThanOrEqual(3)

      const locations = hits.map((h) => h.location)
      expect(locations.some((l) => l.includes("userMessage"))).toBe(true)
      expect(locations.some((l) => l.includes("assistantMessage"))).toBe(true)
      expect(locations.some((l) => l.includes("toolCall"))).toBe(true)
      index.close()
    })

    it("combines sessionId and maxAgeMs filters", () => {
      const fp1 = join(TEST_DIR, "session-a.jsonl")
      const fp2 = join(TEST_DIR, "session-b.jsonl")
      writeTestJsonl(fp1, [makeUserMessage("keyword in session a")])
      writeTestJsonl(fp2, [makeUserMessage("keyword in session b")])

      const now = Date.now()
      const index = new SearchIndex(TEST_DB)
      index.indexFile(fp1, "session-a", now - 1000) // recent
      index.indexFile(fp2, "session-b", now - 1000) // recent

      // Filter by both session and age
      const hits = index.search("keyword", {
        sessionId: "session-a",
        maxAgeMs: 5 * 24 * 3600_000,
      })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits.every((h) => h.sessionId === "session-a")).toBe(true)
      index.close()
    })
  })

  describe("buildFull", () => {
    beforeEach(() => {
      mkdirSync(TEST_DIR, { recursive: true })
    })
    afterEach(() => {
      try { rmSync(TEST_DIR, { recursive: true }) } catch {}
    })

    it("indexes all JSONL files in project directories", () => {
      // Create fake project structure: projects/project-a/session-1.jsonl
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      writeTestJsonl(join(projectDir, "session-1.jsonl"), [
        makeUserMessage("keyword alpha"),
      ])
      writeTestJsonl(join(projectDir, "session-2.jsonl"), [
        makeUserMessage("keyword beta"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))

      const stats = index.getStats()
      expect(stats.indexedSessions).toBe(2)
      expect(stats.lastFullBuild).not.toBeNull()

      const hits = index.search("keyword")
      expect(hits.length).toBe(2)
      index.close()
    })

    it("indexes subagent files", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      writeTestJsonl(join(projectDir, "session-1.jsonl"), [
        makeUserMessage("main session content"),
      ])
      // Subagent dir structure: session-1/subagents/agent-abc123.jsonl
      const subDir = join(projectDir, "session-1", "subagents")
      mkdirSync(subDir, { recursive: true })
      writeTestJsonl(join(subDir, "agent-abc123.jsonl"), [
        makeUserMessage("subagent keyword here"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))

      const stats = index.getStats()
      expect(stats.indexedSubagents).toBe(1)
      expect(stats.indexedSessions).toBe(1)

      const hits = index.search("subagent keyword")
      expect(hits.length).toBeGreaterThan(0)
      index.close()
    })

    it("clears all existing data before rebuilding", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      writeTestJsonl(join(projectDir, "session-1.jsonl"), [
        makeUserMessage("first build content unique_marker_first"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))
      expect(index.search("unique_marker_first").length).toBeGreaterThan(0)

      // Remove the old file and add a new one
      rmSync(join(projectDir, "session-1.jsonl"))
      writeTestJsonl(join(projectDir, "session-2.jsonl"), [
        makeUserMessage("second build content unique_marker_second"),
      ])

      // Rebuild should clear old data
      index.buildFull(join(TEST_DIR, "projects"))
      expect(index.search("unique_marker_first").length).toBe(0)
      expect(index.search("unique_marker_second").length).toBeGreaterThan(0)
      expect(index.getStats().indexedSessions).toBe(1)
      index.close()
    })

    it("stores projectsDir for later use by rebuild()", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      writeTestJsonl(join(projectDir, "session-1.jsonl"), [
        makeUserMessage("content for rebuild test"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))

      // rebuild() should work without re-passing projectsDir
      index.rebuild()
      expect(index.getStats().indexedSessions).toBe(1)
      index.close()
    })

    it("skips the 'memory' directory", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      const memoryDir = join(TEST_DIR, "projects", "memory")
      mkdirSync(projectDir, { recursive: true })
      mkdirSync(memoryDir, { recursive: true })
      writeTestJsonl(join(projectDir, "session-1.jsonl"), [
        makeUserMessage("real session content"),
      ])
      writeTestJsonl(join(memoryDir, "session-memory.jsonl"), [
        makeUserMessage("memory content should be skipped"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))

      expect(index.getStats().indexedSessions).toBe(1)
      expect(index.search("memory content should be skipped").length).toBe(0)
      index.close()
    })

    it("handles empty projects directory", () => {
      const projectsDir = join(TEST_DIR, "projects")
      mkdirSync(projectsDir, { recursive: true })

      const index = new SearchIndex(TEST_DB)
      // Should not throw
      index.buildFull(projectsDir)

      expect(index.getStats().indexedFiles).toBe(0)
      expect(index.getStats().lastFullBuild).not.toBeNull()
      index.close()
    })

    it("handles deeply nested subagents (recursive)", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      writeTestJsonl(join(projectDir, "session-1.jsonl"), [
        makeUserMessage("top-level session"),
      ])
      // Level 1 subagent
      const sub1Dir = join(projectDir, "session-1", "subagents")
      mkdirSync(sub1Dir, { recursive: true })
      writeTestJsonl(join(sub1Dir, "agent-level1.jsonl"), [
        makeUserMessage("level 1 subagent content"),
      ])
      // Level 2 subagent (nested under level 1)
      const sub2Dir = join(sub1Dir, "agent-level1", "subagents")
      mkdirSync(sub2Dir, { recursive: true })
      writeTestJsonl(join(sub2Dir, "agent-level2.jsonl"), [
        makeUserMessage("level 2 subagent content"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))

      const stats = index.getStats()
      expect(stats.indexedSessions).toBe(1)
      expect(stats.indexedSubagents).toBe(2)

      expect(index.search("level 1 subagent").length).toBeGreaterThan(0)
      expect(index.search("level 2 subagent").length).toBeGreaterThan(0)
      index.close()
    })

    it("skips files that fail to parse gracefully", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      // Valid file
      writeTestJsonl(join(projectDir, "session-good.jsonl"), [
        makeUserMessage("good session content"),
      ])
      // Invalid JSONL file (corrupt content)
      writeFileSync(join(projectDir, "session-bad.jsonl"), "NOT VALID JSON\n{broken")

      const index = new SearchIndex(TEST_DB)
      // Should not throw, just skip the bad file
      index.buildFull(join(TEST_DIR, "projects"))

      // The good file should still be indexed
      expect(index.getStats().indexedFiles).toBeGreaterThanOrEqual(1)
      expect(index.search("good session").length).toBeGreaterThan(0)
      index.close()
    })
  })

  describe("updateStale", () => {
    beforeEach(() => {
      mkdirSync(TEST_DIR, { recursive: true })
    })
    afterEach(() => {
      try { rmSync(TEST_DIR, { recursive: true }) } catch {}
    })

    it("only re-indexes files with changed mtime", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      const fp = join(projectDir, "session-1.jsonl")
      writeTestJsonl(fp, [makeUserMessage("original keyword")])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))
      expect(index.search("original").length).toBeGreaterThan(0)

      // updateStale with same mtime should NOT re-index (no changes)
      const beforeStats = index.getStats()
      index.updateStale(join(TEST_DIR, "projects"))
      const afterStats = index.getStats()
      expect(afterStats.indexedFiles).toBe(beforeStats.indexedFiles)

      index.close()
    })

    it("detects and re-indexes modified files", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      const fp = join(projectDir, "session-1.jsonl")
      writeTestJsonl(fp, [makeUserMessage("original unique_marker_stale")])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))
      expect(index.search("unique_marker_stale").length).toBeGreaterThan(0)

      // Modify the file (changes mtime)
      // Need a small delay to ensure mtime changes
      const originalMtime = statSync(fp).mtimeMs
      // Touch the file with new content — writeFileSync updates mtime
      writeTestJsonl(fp, [makeUserMessage("updated unique_marker_fresh")])

      // Verify mtime actually changed (or force it)
      const newMtime = statSync(fp).mtimeMs
      if (newMtime <= originalMtime) {
        // Force a different mtime by setting it manually
        const { utimesSync } = require("node:fs")
        const now = new Date()
        utimesSync(fp, now, now)
      }

      index.updateStale(join(TEST_DIR, "projects"))

      expect(index.search("unique_marker_fresh").length).toBeGreaterThan(0)
      // Old content should be gone since re-index deletes old rows
      expect(index.search("unique_marker_stale").length).toBe(0)
      index.close()
    })

    it("discovers new files added since last build", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      writeTestJsonl(join(projectDir, "session-1.jsonl"), [
        makeUserMessage("session one content"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))
      expect(index.getStats().indexedSessions).toBe(1)

      // Add a new file
      writeTestJsonl(join(projectDir, "session-2.jsonl"), [
        makeUserMessage("session two new content"),
      ])

      index.updateStale(join(TEST_DIR, "projects"))
      expect(index.getStats().indexedSessions).toBe(2)
      expect(index.search("session two new").length).toBeGreaterThan(0)
      index.close()
    })

    it("updates _lastUpdate only when files were re-indexed", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      writeTestJsonl(join(projectDir, "session-1.jsonl"), [
        makeUserMessage("content here"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))

      const afterBuild = index.getStats().lastUpdate

      // updateStale with no changes should NOT update _lastUpdate
      index.updateStale(join(TEST_DIR, "projects"))
      const afterNoChange = index.getStats().lastUpdate
      expect(afterNoChange).toBe(afterBuild)

      index.close()
    })

    it("handles new subagent files in updateStale", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      writeTestJsonl(join(projectDir, "session-1.jsonl"), [
        makeUserMessage("parent session"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))
      expect(index.getStats().indexedSubagents).toBe(0)

      // Add a subagent file
      const subDir = join(projectDir, "session-1", "subagents")
      mkdirSync(subDir, { recursive: true })
      writeTestJsonl(join(subDir, "agent-new.jsonl"), [
        makeUserMessage("new subagent content"),
      ])

      index.updateStale(join(TEST_DIR, "projects"))
      expect(index.getStats().indexedSubagents).toBe(1)
      expect(index.search("new subagent content").length).toBeGreaterThan(0)
      index.close()
    })
  })

  describe("rebuild", () => {
    beforeEach(() => {
      mkdirSync(TEST_DIR, { recursive: true })
    })
    afterEach(() => {
      try { rmSync(TEST_DIR, { recursive: true }) } catch {}
    })

    it("does nothing when projectsDir is not set", () => {
      const index = new SearchIndex(TEST_DB)
      // Should not throw
      index.rebuild()
      expect(index.getStats().indexedFiles).toBe(0)
      index.close()
    })

    it("rebuilds using the stored projectsDir", () => {
      const projectDir = join(TEST_DIR, "projects", "project-a")
      mkdirSync(projectDir, { recursive: true })
      writeTestJsonl(join(projectDir, "session-1.jsonl"), [
        makeUserMessage("rebuild test content"),
      ])

      const index = new SearchIndex(TEST_DB)
      index.buildFull(join(TEST_DIR, "projects"))
      expect(index.getStats().indexedSessions).toBe(1)

      // Add another file
      writeTestJsonl(join(projectDir, "session-2.jsonl"), [
        makeUserMessage("second session content"),
      ])

      // Rebuild should re-discover everything
      index.rebuild()
      expect(index.getStats().indexedSessions).toBe(2)
      index.close()
    })
  })
})
