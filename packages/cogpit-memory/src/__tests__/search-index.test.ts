import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installDirsMock, mockDirs, writeCopilotSession } from "./fixtures"

installDirsMock()

import { SearchIndex } from "../lib/search-index"

describe("SearchIndex", () => {
  let dbPath: string
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-memory-test-"))
    dbPath = join(tmpDir, "test.db")
    mockDirs.PROJECTS_DIR = join(tmpDir, "projects")
    mockDirs.TEAMS_DIR = join(tmpDir, "teams")
    mockDirs.TASKS_DIR = join(tmpDir, "tasks")
    mockDirs.CODEX_SESSIONS_DIR = join(tmpDir, "codex-sessions")
    mockDirs.COPILOT_SESSIONS_DIR = join(tmpDir, "copilot-sessions")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("removes deleted transcripts before applying the search limit", () => {
    const index = new SearchIndex(dbPath)
    const live = join(tmpDir, "live.jsonl")
    const deleted = join(tmpDir, "deleted.jsonl")
    const content = JSON.stringify({ type: "user", message: { role: "user", content: "authentication" } })
    writeFileSync(live, content)
    writeFileSync(deleted, content)
    index.indexFile(live, "live")
    index.indexFile(deleted, "deleted")
    rmSync(deleted)
    expect(index.search("authentication", { limit: 1 }).map((hit) => hit.sessionId)).toEqual(["live"])
    expect(index.countMatches("authentication")).toEqual({ totalHits: 1, sessionsSearched: 1 })
    expect(index.getStats().indexedFiles).toBe(1)
    expect(index.pruneMissingFiles()).toBe(0)
    writeFileSync(deleted, content)
    index.indexFile(deleted, "deleted")
    expect(index.search("authentication")).toHaveLength(2)
    index.close()
  })

  it("excludes a session including its subagent rows before limiting and counting", () => {
    const index = new SearchIndex(dbPath)
    for (const [name, sessionId, isSubagent] of [["old", "old", false], ["current", "current", false], ["agent", "current", true]] as const) {
      const file = join(tmpDir, `${name}.jsonl`)
      writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "authentication" } }))
      index.indexFile(file, sessionId, undefined, { isSubagent, parentSessionId: isSubagent ? sessionId : null })
    }
    expect(index.search("authentication", { excludeSessionId: "current", limit: 1 }).map((hit) => hit.sessionId)).toEqual(["old"])
    expect(index.countMatches("authentication", { excludeSessionId: "current" })).toEqual({ totalHits: 1, sessionsSearched: 1 })
    index.close()
  })

  it("creates database and schema", () => {
    const index = new SearchIndex(dbPath)
    const stats = index.getStats()
    expect(stats.indexedFiles).toBe(0)
    expect(stats.totalRows).toBe(0)
    index.close()
  })

  it("indexes a JSONL file and finds content via search", () => {
    const index = new SearchIndex(dbPath)
    const projectDir = join(tmpDir, "projects", "-test-project")
    mkdirSync(projectDir, { recursive: true })
    const sessionFile = join(projectDir, "test-session.jsonl")

    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "find authentication bugs" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I found an authentication issue" }], model: "claude-opus-4-6", id: "msg1", stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } } }),
    ]
    writeFileSync(sessionFile, lines.join("\n"))
    index.indexFile(sessionFile)

    expect(index.getStats().indexedFiles).toBe(1)
    const hits = index.search("authentication")
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].sessionId).toBe("test-session")
    index.close()
  })

  it("returns structured stats", () => {
    const index = new SearchIndex(dbPath)
    const stats = index.getStats()
    expect(stats).toHaveProperty("dbPath")
    expect(stats).toHaveProperty("dbSizeBytes")
    expect(stats).toHaveProperty("indexedFiles")
    expect(stats).toHaveProperty("totalRows")
    index.close()
  })

  it("builds full index from projects directory", () => {
    const projectDir = join(tmpDir, "projects", "-test-proj")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "s1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "keyword alpha" } }))
    writeFileSync(join(projectDir, "s2.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "keyword beta" } }))

    const index = new SearchIndex(dbPath)
    index.buildFull()
    expect(index.getStats().indexedFiles).toBe(2)
    expect(index.search("keyword").length).toBe(2)
    index.close()
  })

  it("builds a full index from the Copilot session-state directory", () => {
    const copilotDir = join(tmpDir, "copilot-sessions")
    const sessionId = "11111111-1111-4111-8111-111111111111"
    const sessionFile = writeCopilotSession(copilotDir, sessionId, {
      userMessage: "copilot full index needle",
    })

    const index = new SearchIndex(dbPath)
    index.buildFull()

    expect(index.getStats().indexedFiles).toBe(1)
    expect(index.search("full index needle")).toEqual([
      expect.objectContaining({ sessionId, filePath: sessionFile }),
    ])
    index.close()
  })

  it("incrementally indexes new Copilot sessions", () => {
    const projectsDir = join(tmpDir, "projects")
    const copilotDir = join(tmpDir, "copilot-sessions")
    const sessionId = "22222222-2222-4222-8222-222222222222"
    mkdirSync(projectsDir, { recursive: true })

    const index = new SearchIndex(dbPath)
    index.buildFull()
    writeCopilotSession(copilotDir, sessionId, {
      userMessage: "copilot incremental needle",
    })
    index.updateRecent(50)

    expect(index.getStats().indexedFiles).toBe(1)
    expect(index.search("incremental needle")).toEqual([
      expect.objectContaining({ sessionId }),
    ])
    index.close()
  })

  it("countMatches returns totalHits and sessionsSearched", () => {
    const index = new SearchIndex(dbPath)
    const projectDir = join(tmpDir, "projects", "-test-proj")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "s1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "unique searchterm here" } }))
    writeFileSync(join(projectDir, "s2.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "another unique searchterm" } }))

    index.buildFull()
    const counts = index.countMatches("searchterm")
    expect(counts.totalHits).toBe(2)
    expect(counts.sessionsSearched).toBe(2)
    index.close()
  })

  it("search supports sessionId filter", () => {
    const index = new SearchIndex(dbPath)
    const projectDir = join(tmpDir, "projects", "-test-proj")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "sess-a.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "common keyword" } }))
    writeFileSync(join(projectDir, "sess-b.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "common keyword" } }))

    index.buildFull()
    const allHits = index.search("common keyword")
    expect(allHits.length).toBe(2)

    const filteredHits = index.search("common keyword", { sessionId: "sess-a" })
    expect(filteredHits.length).toBe(1)
    expect(filteredHits[0].sessionId).toBe("sess-a")
    index.close()
  })

  it("indexFile is idempotent — re-indexing same file doesn't duplicate", () => {
    const index = new SearchIndex(dbPath)
    const projectDir = join(tmpDir, "projects", "-test-proj")
    mkdirSync(projectDir, { recursive: true })
    const sessionFile = join(projectDir, "dedup.jsonl")
    writeFileSync(sessionFile, JSON.stringify({ type: "user", message: { role: "user", content: "deduplicate me" } }))

    index.indexFile(sessionFile)
    index.indexFile(sessionFile)

    expect(index.getStats().indexedFiles).toBe(1)
    expect(index.search("deduplicate").length).toBe(1)
    index.close()
  })
})
