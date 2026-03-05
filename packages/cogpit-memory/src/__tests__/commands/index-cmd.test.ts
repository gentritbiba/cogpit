// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// Mock dirs so tests use temp directories instead of real filesystem.
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
  get DEFAULT_DB_PATH() {
    return join(projectsDir, "..", "cogpit-memory", "search-index.db")
  },
}))

// Import after mock setup
import { indexStats, indexRebuild } from "../../commands/index-cmd"
import type { IndexStats } from "../../lib/search-index"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a minimal JSONL session file with a user + assistant turn. */
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("index command", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-index-test-"))
    projectsDir = join(tmpDir, "projects")
    mkdirSync(projectsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── indexStats ───────────────────────────────────────────────────────────

  describe("indexStats", () => {
    it("returns error when DB does not exist", async () => {
      const result = await indexStats("/nonexistent/db/path.db")
      expect(result).toHaveProperty("error")
      expect((result as { error: string }).error).toContain("Database not found")
    })

    it("returns error when default DB path does not exist", async () => {
      // DEFAULT_DB_PATH points to a non-existent file in the temp dir
      const result = await indexStats()
      expect(result).toHaveProperty("error")
    })

    it("returns IndexStats when DB exists", async () => {
      // First rebuild to create the DB
      const dbPath = join(tmpDir, "cogpit-memory", "test.db")
      await indexRebuild(dbPath)

      const result = await indexStats(dbPath)
      expect(result).not.toHaveProperty("error")

      const stats = result as IndexStats
      expect(stats).toHaveProperty("dbPath")
      expect(stats).toHaveProperty("dbSizeBytes")
      expect(stats).toHaveProperty("dbSizeMB")
      expect(stats).toHaveProperty("indexedFiles")
      expect(stats).toHaveProperty("indexedSessions")
      expect(stats).toHaveProperty("indexedSubagents")
      expect(stats).toHaveProperty("totalRows")
      expect(stats).toHaveProperty("watcherRunning")
      expect(stats).toHaveProperty("lastFullBuild")
      expect(stats).toHaveProperty("lastUpdate")
      expect(stats.dbPath).toBe(dbPath)
    })

    it("reports correct counts after indexing sessions", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "s1.jsonl", { userMessage: "first session" })
      writeSession(projDir, "s2.jsonl", { userMessage: "second session" })

      const dbPath = join(tmpDir, "cogpit-memory", "stats-count.db")
      await indexRebuild(dbPath)

      const result = await indexStats(dbPath)
      expect(result).not.toHaveProperty("error")

      const stats = result as IndexStats
      expect(stats.indexedFiles).toBe(2)
      expect(stats.indexedSessions).toBe(2)
      expect(stats.totalRows).toBeGreaterThan(0)
      expect(stats.dbSizeBytes).toBeGreaterThan(0)
    })
  })

  // ── indexRebuild ─────────────────────────────────────────────────────────

  describe("indexRebuild", () => {
    it("creates the DB file and returns rebuilt status", async () => {
      const dbPath = join(tmpDir, "cogpit-memory", "rebuild.db")
      const result = await indexRebuild(dbPath)

      expect(result.status).toBe("rebuilt")
      expect(result.stats).toHaveProperty("dbPath")
      expect(result.stats.dbPath).toBe(dbPath)
    })

    it("indexes session files during rebuild", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "sess-a.jsonl", { userMessage: "alpha content" })
      writeSession(projDir, "sess-b.jsonl", { userMessage: "beta content" })

      const dbPath = join(tmpDir, "cogpit-memory", "rebuild-sessions.db")
      const result = await indexRebuild(dbPath)

      expect(result.status).toBe("rebuilt")
      expect(result.stats.indexedFiles).toBe(2)
      expect(result.stats.indexedSessions).toBe(2)
      expect(result.stats.totalRows).toBeGreaterThan(0)
    })

    it("returns zero counts when no sessions exist", async () => {
      const dbPath = join(tmpDir, "cogpit-memory", "rebuild-empty.db")
      const result = await indexRebuild(dbPath)

      expect(result.status).toBe("rebuilt")
      expect(result.stats.indexedFiles).toBe(0)
      expect(result.stats.indexedSessions).toBe(0)
      expect(result.stats.totalRows).toBe(0)
    })

    it("creates parent directories if they do not exist", async () => {
      const dbPath = join(tmpDir, "deep", "nested", "dir", "index.db")
      const result = await indexRebuild(dbPath)

      expect(result.status).toBe("rebuilt")
      expect(result.stats.dbPath).toBe(dbPath)
    })

    it("re-indexes cleanly on a second rebuild", async () => {
      const projDir = join(projectsDir, "-test-project")
      mkdirSync(projDir, { recursive: true })
      writeSession(projDir, "s1.jsonl", { userMessage: "first pass" })

      const dbPath = join(tmpDir, "cogpit-memory", "rebuild-twice.db")

      // First rebuild
      const result1 = await indexRebuild(dbPath)
      expect(result1.stats.indexedFiles).toBe(1)

      // Add another session
      writeSession(projDir, "s2.jsonl", { userMessage: "second pass" })

      // Second rebuild
      const result2 = await indexRebuild(dbPath)
      expect(result2.stats.indexedFiles).toBe(2)
      expect(result2.stats.indexedSessions).toBe(2)
    })

    it("records lastFullBuild timestamp", async () => {
      const dbPath = join(tmpDir, "cogpit-memory", "rebuild-ts.db")
      const before = new Date().toISOString()
      const result = await indexRebuild(dbPath)

      expect(result.stats.lastFullBuild).not.toBeNull()
      // lastFullBuild should be >= before
      expect(result.stats.lastFullBuild! >= before).toBe(true)
    })
  })
})
