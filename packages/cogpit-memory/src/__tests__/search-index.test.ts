import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { SearchIndex } from "../lib/search-index"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

function writeCopilotSession(root: string, sessionId: string, message: string): string {
  const sessionDir = join(root, sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const filePath = join(sessionDir, "events.jsonl")
  const timestamp = new Date().toISOString()
  writeFileSync(filePath, [
    JSON.stringify({
      type: "session.start",
      data: { sessionId, context: { cwd: "/test/copilot" } },
      timestamp,
    }),
    JSON.stringify({ type: "user.message", data: { content: message }, timestamp }),
  ].join("\n"))
  return filePath
}

describe("SearchIndex", () => {
  let dbPath: string
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cogpit-memory-test-"))
    dbPath = join(tmpDir, "test.db")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
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
    expect(stats).toHaveProperty("watcherRunning")
    index.close()
  })

  it("builds full index from projects directory", () => {
    const projectDir = join(tmpDir, "projects", "-test-proj")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "s1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "keyword alpha" } }))
    writeFileSync(join(projectDir, "s2.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "keyword beta" } }))

    const index = new SearchIndex(dbPath)
    index.buildFull(join(tmpDir, "projects"))
    expect(index.getStats().indexedFiles).toBe(2)
    expect(index.search("keyword").length).toBe(2)
    index.close()
  })

  it("builds a full index from the Copilot session-state directory", () => {
    const copilotDir = join(tmpDir, "copilot-sessions")
    const sessionId = "11111111-1111-4111-8111-111111111111"
    const sessionFile = writeCopilotSession(copilotDir, sessionId, "copilot full index needle")

    const index = new SearchIndex(dbPath)
    index.buildFull(join(tmpDir, "missing-projects"), copilotDir)

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
    index.buildFull(projectsDir, copilotDir)
    writeCopilotSession(copilotDir, sessionId, "copilot incremental needle")
    index.updateRecent(projectsDir, 50, copilotDir)

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

    index.buildFull(join(tmpDir, "projects"))
    const counts = index.countMatches("searchterm")
    expect(counts.totalHits).toBe(2)
    expect(counts.sessionsSearched).toBe(2)
    index.close()
  })

  it("updateStale only re-indexes changed files", () => {
    const index = new SearchIndex(dbPath)
    const projectDir = join(tmpDir, "projects", "-test-proj")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "s1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "original content" } }))

    index.buildFull(join(tmpDir, "projects"))
    expect(index.getStats().indexedFiles).toBe(1)

    // Add a new file
    writeFileSync(join(projectDir, "s2.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "new content" } }))
    index.updateStale(join(tmpDir, "projects"))
    expect(index.getStats().indexedFiles).toBe(2)
    index.close()
  })

  it("rebuild re-indexes from stored projectsDir", () => {
    const index = new SearchIndex(dbPath)
    const projectDir = join(tmpDir, "projects", "-test-proj")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "s1.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "rebuild test" } }))

    index.buildFull(join(tmpDir, "projects"))
    expect(index.getStats().indexedFiles).toBe(1)

    // rebuild should work without passing projectsDir again
    index.rebuild()
    expect(index.getStats().indexedFiles).toBe(1)
    index.close()
  })

  it("search supports sessionId filter", () => {
    const index = new SearchIndex(dbPath)
    const projectDir = join(tmpDir, "projects", "-test-proj")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, "sess-a.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "common keyword" } }))
    writeFileSync(join(projectDir, "sess-b.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "common keyword" } }))

    index.buildFull(join(tmpDir, "projects"))
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
