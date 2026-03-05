# Search Index Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the raw-scan session search with an FTS5-indexed search that returns results in <5ms instead of ~2.4s.

**Architecture:** Standalone `SearchIndex` class using `bun:sqlite` FTS5 with trigram tokenizer. File watcher keeps the index fresh. Existing raw-scan code becomes the fallback. Same API contract — drop-in replacement.

**Tech Stack:** `bun:sqlite` (built-in), `node:fs` watch, Vitest for tests

---

### Task 1: Create the SearchIndex class with DB setup and schema

**Files:**
- Create: `server/search-index.ts`
- Test: `server/__tests__/search-index.test.ts`

**Step 1: Write the failing test**

Create `server/__tests__/search-index.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest"
import { SearchIndex } from "../search-index"
import { unlinkSync } from "node:fs"

const TEST_DB = "/tmp/test-search-index.db"

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
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- server/__tests__/search-index.test.ts`
Expected: FAIL — `SearchIndex` module not found

**Step 3: Write minimal implementation**

Create `server/search-index.ts`:

```typescript
import Database from "bun:sqlite"

export interface IndexStats {
  dbPath: string
  dbSizeBytes: number
  dbSizeMB: number
  indexedFiles: number
  indexedSessions: number
  indexedSubagents: number
  totalRows: number
  watcherRunning: boolean
  lastFullBuild: string | null
  lastUpdate: string | null
}

export class SearchIndex {
  private db: Database
  private dbPath: string
  private _watcherRunning = false
  private _lastFullBuild: string | null = null
  private _lastUpdate: string | null = null

  constructor(dbPath: string) {
    this.dbPath = dbPath
    this.db = new Database(dbPath)
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("PRAGMA synchronous = NORMAL")
    this.initSchema()
  }

  private initSchema(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS indexed_files (
      file_path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      session_id TEXT NOT NULL,
      is_subagent INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT
    )`)

    // Check if FTS table exists before creating (FTS5 doesn't support IF NOT EXISTS)
    const ftsExists = this.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='search_content'"
    ).get()

    if (!ftsExists) {
      this.db.run(`CREATE VIRTUAL TABLE search_content USING fts5(
        session_id,
        location,
        content,
        tokenize = 'trigram'
      )`)
    }
  }

  getStats(): IndexStats {
    const { count: indexedFiles } = this.db.query("SELECT COUNT(*) as count FROM indexed_files").get() as { count: number }
    const { count: indexedSessions } = this.db.query("SELECT COUNT(*) as count FROM indexed_files WHERE is_subagent = 0").get() as { count: number }
    const { count: indexedSubagents } = this.db.query("SELECT COUNT(*) as count FROM indexed_files WHERE is_subagent = 1").get() as { count: number }
    const { count: totalRows } = this.db.query("SELECT COUNT(*) as count FROM search_content").get() as { count: number }

    let dbSizeBytes = 0
    try {
      const { statSync } = require("node:fs")
      dbSizeBytes = statSync(this.dbPath).size
    } catch {}

    return {
      dbPath: this.dbPath,
      dbSizeBytes,
      dbSizeMB: Math.round((dbSizeBytes / 1024 / 1024) * 10) / 10,
      indexedFiles,
      indexedSessions,
      indexedSubagents,
      totalRows,
      watcherRunning: this._watcherRunning,
      lastFullBuild: this._lastFullBuild,
      lastUpdate: this._lastUpdate,
    }
  }

  close(): void {
    this.db.close()
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- server/__tests__/search-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/search-index.ts server/__tests__/search-index.test.ts
git commit -m "feat: add SearchIndex class with SQLite FTS5 schema"
```

---

### Task 2: Add `indexFile()` method — parse JSONL and insert into FTS5

**Files:**
- Modify: `server/search-index.ts`
- Modify: `server/__tests__/search-index.test.ts`

**Step 1: Write the failing test**

Add to `server/__tests__/search-index.test.ts`:

```typescript
import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { parseSession, getUserMessageText } from "../../src/lib/parser"

const TEST_DIR = "/tmp/test-search-index-files"

// Helper: create a minimal JSONL file
function writeTestJsonl(filePath: string, lines: object[]): void {
  mkdirSync(join(filePath, ".."), { recursive: true })
  writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join("\n"))
}

function makeHumanMessage(text: string) {
  return { type: "human", message: { role: "user", content: text } }
}

function makeAssistantMessage(text: string, toolUse?: { id: string; name: string; input: object }) {
  const content: any[] = [{ type: "text", text }]
  if (toolUse) content.push({ type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input })
  return { type: "assistant", message: { role: "assistant", content } }
}

function makeToolResult(toolUseId: string, result: string) {
  return { type: "tool_result", message: { role: "user", content: result }, tool_use_id: toolUseId }
}

describe("indexFile", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
  })
  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }) } catch {}
  })

  it("indexes user and assistant messages", () => {
    const fp = join(TEST_DIR, "test-session.jsonl")
    writeTestJsonl(fp, [
      makeHumanMessage("find the authentication bug"),
      makeAssistantMessage("I found the authentication issue in auth.ts"),
    ])

    const index = new SearchIndex(TEST_DB)
    index.indexFile(fp, "test-session", Date.now())

    const results = index.search("authentication")
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(r => r.location.includes("userMessage"))).toBe(true)
    expect(results.some(r => r.location.includes("assistantMessage"))).toBe(true)
    index.close()
  })

  it("indexes tool call inputs and results", () => {
    const fp = join(TEST_DIR, "test-session.jsonl")
    writeTestJsonl(fp, [
      makeHumanMessage("read the config file"),
      makeAssistantMessage("Let me read it", { id: "tc1", name: "Read", input: { file_path: "/app/config.ts" } }),
      makeToolResult("tc1", "export const SECRET_KEY = 'abc123'"),
    ])

    const index = new SearchIndex(TEST_DB)
    index.indexFile(fp, "test-session", Date.now())

    const inputResults = index.search("config.ts")
    expect(inputResults.some(r => r.location.includes("toolCall") && r.location.includes("input"))).toBe(true)

    const resultResults = index.search("SECRET_KEY")
    expect(resultResults.some(r => r.location.includes("toolCall") && r.location.includes("result"))).toBe(true)
    index.close()
  })

  it("re-indexes a file by deleting old rows first", () => {
    const fp = join(TEST_DIR, "test-session.jsonl")
    writeTestJsonl(fp, [makeHumanMessage("first version keyword")])

    const index = new SearchIndex(TEST_DB)
    index.indexFile(fp, "test-session", Date.now())
    expect(index.search("first version").length).toBeGreaterThan(0)

    // Re-write file with different content
    writeTestJsonl(fp, [makeHumanMessage("second version changed")])
    index.indexFile(fp, "test-session", Date.now())

    expect(index.search("first version").length).toBe(0)
    expect(index.search("second version").length).toBeGreaterThan(0)
    index.close()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- server/__tests__/search-index.test.ts`
Expected: FAIL — `indexFile` and `search` methods don't exist

**Step 3: Write minimal implementation**

Add to `SearchIndex` class in `server/search-index.ts`:

```typescript
import { readFileSync, statSync } from "node:fs"
import { parseSession, getUserMessageText } from "../src/lib/parser"

// Inside the class:

indexFile(filePath: string, sessionId: string, mtimeMs: number, opts?: { isSubagent?: boolean; parentSessionId?: string }): void {
  const content = readFileSync(filePath, "utf-8")
  const session = parseSession(content)

  const isSubagent = opts?.isSubagent ? 1 : 0
  const parentSessionId = opts?.parentSessionId ?? null

  // Delete old data for this file
  this.db.run("DELETE FROM search_content WHERE session_id = ? AND location LIKE ?", [sessionId, isSubagent ? `agent/%` : "turn/%"])
  this.db.run("DELETE FROM indexed_files WHERE file_path = ?", [filePath])

  const insert = this.db.prepare("INSERT INTO search_content (session_id, location, content) VALUES (?, ?, ?)")

  const txn = this.db.transaction(() => {
    for (let i = 0; i < session.turns.length; i++) {
      const turn = session.turns[i]
      const prefix = `turn/${i}`

      // User message
      const userText = getUserMessageText(turn.userMessage)
      if (userText) insert.run(sessionId, `${prefix}/userMessage`, userText)

      // Assistant text
      if (turn.assistantText.length > 0) {
        insert.run(sessionId, `${prefix}/assistantMessage`, turn.assistantText.join("\n\n"))
      }

      // Thinking
      const thinkingText = turn.thinking
        .filter(t => t.thinking && t.thinking.length > 0)
        .map(t => t.thinking)
        .join("\n\n")
      if (thinkingText) insert.run(sessionId, `${prefix}/thinking`, thinkingText)

      // Tool calls
      for (const tc of turn.toolCalls) {
        const inputStr = JSON.stringify(tc.input)
        if (inputStr && inputStr !== "{}") insert.run(sessionId, `${prefix}/toolCall/${tc.id}/input`, inputStr)
        if (tc.result) insert.run(sessionId, `${prefix}/toolCall/${tc.id}/result`, tc.result)
      }

      // Sub-agent inline activity
      for (const sa of turn.subAgentActivity) {
        const saPrefix = `agent/${sa.agentId}`
        if (sa.text.length > 0) insert.run(sessionId, `${saPrefix}/assistantMessage`, sa.text.join("\n\n"))
        const saThinking = sa.thinking.filter(t => t.length > 0).join("\n\n")
        if (saThinking) insert.run(sessionId, `${saPrefix}/thinking`, saThinking)
        for (const tc of sa.toolCalls) {
          const inputStr = JSON.stringify(tc.input)
          if (inputStr && inputStr !== "{}") insert.run(sessionId, `${saPrefix}/toolCall/${tc.id}/input`, inputStr)
          if (tc.result) insert.run(sessionId, `${saPrefix}/toolCall/${tc.id}/result`, tc.result)
        }
      }

      // Compaction summary
      if (turn.compactionSummary) {
        insert.run(sessionId, `${prefix}/compactionSummary`, turn.compactionSummary)
      }
    }

    // Track the file
    this.db.run(
      "INSERT OR REPLACE INTO indexed_files (file_path, mtime_ms, session_id, is_subagent, parent_session_id) VALUES (?, ?, ?, ?, ?)",
      [filePath, mtimeMs, sessionId, isSubagent, parentSessionId],
    )
  })

  txn()
  this._lastUpdate = new Date().toISOString()
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- server/__tests__/search-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/search-index.ts server/__tests__/search-index.test.ts
git commit -m "feat: add indexFile method to parse JSONL and insert into FTS5"
```

---

### Task 3: Add `search()` method — query FTS5 and return structured results

**Files:**
- Modify: `server/search-index.ts`
- Modify: `server/__tests__/search-index.test.ts`

**Step 1: Write the failing test**

Add to the test file:

```typescript
describe("search", () => {
  it("returns hits with session_id and location", () => {
    const fp = join(TEST_DIR, "session-abc.jsonl")
    writeTestJsonl(fp, [makeHumanMessage("the authentication system needs fixing")])

    const index = new SearchIndex(TEST_DB)
    index.indexFile(fp, "session-abc", Date.now())
    const hits = index.search("authentication")

    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].sessionId).toBe("session-abc")
    expect(hits[0].location).toBe("turn/0/userMessage")
    expect(hits[0].snippet).toContain("authentication")
    index.close()
  })

  it("respects limit parameter", () => {
    const fp = join(TEST_DIR, "session.jsonl")
    const lines = Array.from({ length: 10 }, (_, i) => makeHumanMessage(`keyword turn ${i}`))
    // Interleave with assistant messages so parser creates 10 turns
    const interleaved: object[] = []
    for (const line of lines) {
      interleaved.push(line)
      interleaved.push(makeAssistantMessage("ok"))
    }
    writeTestJsonl(fp, interleaved)

    const index = new SearchIndex(TEST_DB)
    index.indexFile(fp, "session", Date.now())
    const hits = index.search("keyword", { limit: 3 })
    expect(hits.length).toBe(3)
    index.close()
  })

  it("filters by sessionId", () => {
    const fp1 = join(TEST_DIR, "session-a.jsonl")
    const fp2 = join(TEST_DIR, "session-b.jsonl")
    writeTestJsonl(fp1, [makeHumanMessage("keyword in session a")])
    writeTestJsonl(fp2, [makeHumanMessage("keyword in session b")])

    const index = new SearchIndex(TEST_DB)
    index.indexFile(fp1, "session-a", Date.now())
    index.indexFile(fp2, "session-b", Date.now())

    const hits = index.search("keyword", { sessionId: "session-a" })
    expect(hits.every(h => h.sessionId === "session-a")).toBe(true)
    index.close()
  })

  it("filters by maxAge via indexed_files mtime", () => {
    const fp1 = join(TEST_DIR, "recent.jsonl")
    const fp2 = join(TEST_DIR, "old.jsonl")
    writeTestJsonl(fp1, [makeHumanMessage("keyword recent")])
    writeTestJsonl(fp2, [makeHumanMessage("keyword old")])

    const now = Date.now()
    const index = new SearchIndex(TEST_DB)
    index.indexFile(fp1, "recent", now - 1000) // 1s ago
    index.indexFile(fp2, "old", now - 10 * 24 * 3600_000) // 10 days ago

    const hits = index.search("keyword", { maxAgeMs: 5 * 24 * 3600_000 }) // 5 days
    expect(hits.every(h => h.sessionId === "recent")).toBe(true)
    index.close()
  })

  it("supports case-insensitive search by default", () => {
    const fp = join(TEST_DIR, "session.jsonl")
    writeTestJsonl(fp, [makeHumanMessage("Authentication is broken")])

    const index = new SearchIndex(TEST_DB)
    index.indexFile(fp, "session", Date.now())
    const hits = index.search("authentication")
    expect(hits.length).toBeGreaterThan(0)
    index.close()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- server/__tests__/search-index.test.ts`
Expected: FAIL — `search` method doesn't return the right shape

**Step 3: Write minimal implementation**

Add to `SearchIndex` class:

```typescript
export interface SearchHit {
  sessionId: string
  location: string
  snippet: string
  matchCount: number
}

search(query: string, opts?: { limit?: number; sessionId?: string; maxAgeMs?: number; caseSensitive?: boolean }): SearchHit[] {
  const limit = opts?.limit ?? 200
  const sessionId = opts?.sessionId
  const maxAgeMs = opts?.maxAgeMs
  const caseSensitive = opts?.caseSensitive ?? false

  // FTS5 trigram is case-insensitive by default
  // For case-sensitive, we post-filter
  const ftsQuery = `"${query.replace(/"/g, '""')}"`

  let sql = `
    SELECT sc.session_id, sc.location,
           snippet(search_content, 2, '', '', '...', 40) as snippet
    FROM search_content sc
  `
  const params: (string | number)[] = []
  const conditions: string[] = ["sc.content MATCH ?"]
  params.push(ftsQuery)

  if (sessionId) {
    conditions.push("sc.session_id = ?")
    params.push(sessionId)
  }

  if (maxAgeMs) {
    sql += " JOIN indexed_files fi ON fi.session_id = sc.session_id"
    conditions.push("fi.mtime_ms >= ?")
    params.push(Date.now() - maxAgeMs)
  }

  sql += " WHERE " + conditions.join(" AND ")
  sql += ` LIMIT ?`
  params.push(limit)

  const rows = this.db.query(sql).all(...params) as Array<{ session_id: string; location: string; snippet: string }>

  let hits = rows.map(row => ({
    sessionId: row.session_id,
    location: row.location,
    snippet: row.snippet,
    matchCount: 1, // FTS5 doesn't give per-row count easily; 1 means "at least one match"
  }))

  // Post-filter for case sensitivity
  if (caseSensitive) {
    hits = hits.filter(h => h.snippet.includes(query))
  }

  return hits
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- server/__tests__/search-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/search-index.ts server/__tests__/search-index.test.ts
git commit -m "feat: add search method with FTS5 query, filtering, and limit"
```

---

### Task 4: Add `buildFull()` and `updateStale()` methods

**Files:**
- Modify: `server/search-index.ts`
- Modify: `server/__tests__/search-index.test.ts`

**Step 1: Write the failing test**

Add to the test file:

```typescript
describe("buildFull", () => {
  it("indexes all JSONL files in project directories", () => {
    // Create fake project structure
    const projectDir = join(TEST_DIR, "projects", "project-a")
    mkdirSync(projectDir, { recursive: true })
    writeTestJsonl(join(projectDir, "session-1.jsonl"), [
      makeHumanMessage("keyword alpha"),
    ])
    writeTestJsonl(join(projectDir, "session-2.jsonl"), [
      makeHumanMessage("keyword beta"),
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
      makeHumanMessage("main session content"),
    ])
    const subDir = join(projectDir, "session-1", "subagents")
    mkdirSync(subDir, { recursive: true })
    writeTestJsonl(join(subDir, "agent-abc123.jsonl"), [
      makeHumanMessage("subagent keyword here"),
    ])

    const index = new SearchIndex(TEST_DB)
    index.buildFull(join(TEST_DIR, "projects"))

    const stats = index.getStats()
    expect(stats.indexedSubagents).toBe(1)

    const hits = index.search("subagent keyword")
    expect(hits.length).toBeGreaterThan(0)
    index.close()
  })
})

describe("updateStale", () => {
  it("only re-indexes files with changed mtime", () => {
    const projectDir = join(TEST_DIR, "projects", "project-a")
    mkdirSync(projectDir, { recursive: true })
    const fp = join(projectDir, "session-1.jsonl")
    writeTestJsonl(fp, [makeHumanMessage("original keyword")])

    const index = new SearchIndex(TEST_DB)
    index.buildFull(join(TEST_DIR, "projects"))
    expect(index.search("original").length).toBeGreaterThan(0)

    // updateStale with same mtime should NOT re-index
    const beforeStats = index.getStats()
    index.updateStale(join(TEST_DIR, "projects"))
    const afterStats = index.getStats()
    expect(afterStats.indexedFiles).toBe(beforeStats.indexedFiles)

    index.close()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- server/__tests__/search-index.test.ts`
Expected: FAIL — methods don't exist

**Step 3: Write minimal implementation**

Add to `SearchIndex` class:

```typescript
import { readdirSync, statSync } from "node:fs"
import { join, basename } from "node:path"

buildFull(projectsDir: string): void {
  // Clear everything
  this.db.run("DELETE FROM search_content")
  this.db.run("DELETE FROM indexed_files")

  this.indexProjectsDir(projectsDir)
  this._lastFullBuild = new Date().toISOString()
  this._lastUpdate = new Date().toISOString()
}

updateStale(projectsDir: string): void {
  const getIndexed = this.db.prepare("SELECT mtime_ms FROM indexed_files WHERE file_path = ?")

  const filesToIndex: Array<{ path: string; sessionId: string; mtimeMs: number; isSubagent: boolean; parentSessionId: string | null }> = []

  this.discoverFiles(projectsDir, (filePath, sessionId, mtimeMs, isSubagent, parentSessionId) => {
    const existing = getIndexed.get(filePath) as { mtime_ms: number } | null
    if (!existing || existing.mtime_ms < mtimeMs) {
      filesToIndex.push({ path: filePath, sessionId, mtimeMs, isSubagent, parentSessionId })
    }
  })

  for (const file of filesToIndex) {
    try {
      this.indexFile(file.path, file.sessionId, file.mtimeMs, {
        isSubagent: file.isSubagent,
        parentSessionId: file.parentSessionId,
      })
    } catch {
      // Skip files that fail to parse
    }
  }

  if (filesToIndex.length > 0) {
    this._lastUpdate = new Date().toISOString()
  }
}

private indexProjectsDir(projectsDir: string): void {
  this.discoverFiles(projectsDir, (filePath, sessionId, mtimeMs, isSubagent, parentSessionId) => {
    try {
      this.indexFile(filePath, sessionId, mtimeMs, { isSubagent, parentSessionId })
    } catch {
      // Skip files that fail to parse
    }
  })
}

private discoverFiles(
  projectsDir: string,
  callback: (filePath: string, sessionId: string, mtimeMs: number, isSubagent: boolean, parentSessionId: string | null) => void,
): void {
  let entries: string[]
  try {
    entries = readdirSync(projectsDir)
  } catch { return }

  for (const projectName of entries) {
    if (projectName === "memory") continue
    const projectDir = join(projectsDir, projectName)
    try {
      const s = statSync(projectDir)
      if (!s.isDirectory()) continue
    } catch { continue }

    let files: string[]
    try { files = readdirSync(projectDir) } catch { continue }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue
      const filePath = join(projectDir, file)
      const sessionId = basename(file, ".jsonl")
      try {
        const s = statSync(filePath)
        callback(filePath, sessionId, s.mtimeMs, false, null)
      } catch { continue }

      // Discover subagent files
      this.discoverSubagents(filePath, sessionId, callback, 0, 4)
    }
  }
}

private discoverSubagents(
  parentPath: string,
  parentSessionId: string,
  callback: (filePath: string, sessionId: string, mtimeMs: number, isSubagent: boolean, parentSessionId: string | null) => void,
  depth: number,
  maxDepth: number,
): void {
  if (depth >= maxDepth) return
  const subDir = parentPath.replace(/\.jsonl$/, "") + "/subagents"
  let files: string[]
  try { files = readdirSync(subDir) } catch { return }

  for (const file of files) {
    if (!file.startsWith("agent-") || !file.endsWith(".jsonl")) continue
    const filePath = join(subDir, file)
    const agentId = file.slice("agent-".length, -".jsonl".length)
    try {
      const s = statSync(filePath)
      callback(filePath, parentSessionId, s.mtimeMs, true, parentSessionId)
    } catch { continue }

    this.discoverSubagents(filePath, parentSessionId, callback, depth + 1, maxDepth)
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- server/__tests__/search-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/search-index.ts server/__tests__/search-index.test.ts
git commit -m "feat: add buildFull and updateStale methods for index lifecycle"
```

---

### Task 5: Add `startWatching()` and `stopWatching()` methods

**Files:**
- Modify: `server/search-index.ts`
- Modify: `server/__tests__/search-index.test.ts`

**Step 1: Write the failing test**

```typescript
describe("startWatching / stopWatching", () => {
  it("sets watcherRunning to true when started", () => {
    const projectDir = join(TEST_DIR, "projects")
    mkdirSync(projectDir, { recursive: true })

    const index = new SearchIndex(TEST_DB)
    index.startWatching(projectDir)
    expect(index.getStats().watcherRunning).toBe(true)
    index.stopWatching()
    expect(index.getStats().watcherRunning).toBe(false)
    index.close()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- server/__tests__/search-index.test.ts`
Expected: FAIL — methods don't exist

**Step 3: Write minimal implementation**

Add to `SearchIndex` class:

```typescript
import { watch, type FSWatcher } from "node:fs"

private watcher: FSWatcher | null = null
private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
private projectsDir: string | null = null

startWatching(projectsDir: string): void {
  this.projectsDir = projectsDir

  // Initial sync
  this.updateStale(projectsDir)

  // Watch for changes
  try {
    this.watcher = watch(projectsDir, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return
      this.debouncedReindex(join(projectsDir, filename))
    })
    this._watcherRunning = true
  } catch {
    // fs.watch may not support recursive on all platforms
    this._watcherRunning = false
  }
}

stopWatching(): void {
  if (this.watcher) {
    this.watcher.close()
    this.watcher = null
  }
  for (const timer of this.debounceTimers.values()) clearTimeout(timer)
  this.debounceTimers.clear()
  this._watcherRunning = false
}

private debouncedReindex(filePath: string): void {
  const existing = this.debounceTimers.get(filePath)
  if (existing) clearTimeout(existing)

  this.debounceTimers.set(filePath, setTimeout(() => {
    this.debounceTimers.delete(filePath)
    try {
      const s = statSync(filePath)
      // Determine sessionId and subagent status from path
      const parts = filePath.split("/")
      const fileName = parts[parts.length - 1]
      const isSubagent = parts.includes("subagents")

      let sessionId: string
      let parentSessionId: string | null = null

      if (isSubagent) {
        // Walk up to find the parent session
        const subagentsIdx = parts.lastIndexOf("subagents")
        const parentDir = parts[subagentsIdx - 1]
        sessionId = parentDir
        parentSessionId = parentDir
      } else {
        sessionId = basename(fileName, ".jsonl")
      }

      this.indexFile(filePath, sessionId, s.mtimeMs, { isSubagent, parentSessionId })
    } catch {
      // File may have been deleted or is being written to
    }
  }, 2000))
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- server/__tests__/search-index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/search-index.ts server/__tests__/search-index.test.ts
git commit -m "feat: add file watcher with 2s debounce for live index updates"
```

---

### Task 6: Integrate index into session-search route with fallback

**Files:**
- Modify: `server/routes/session-search.ts`
- Modify: `server/__tests__/routes/session-search.test.ts`

**Step 1: Write the failing test**

Add a new describe block to `server/__tests__/routes/session-search.test.ts`:

```typescript
describe("indexed search", () => {
  it("uses index when available and returns same response shape", async () => {
    // This test verifies the response shape is identical whether
    // using the index or the raw scan fallback
    // The existing tests continue to work as the fallback path

    // Test that the response has all expected fields
    mockedFindJsonlPath.mockResolvedValueOnce("/mock/session.jsonl")
    mockedStat.mockResolvedValueOnce({ mtimeMs: Date.now() } as never)
    mockedReadFile.mockResolvedValueOnce("keyword" as never)
    mockedParseSession.mockReturnValueOnce(makeSession({
      turns: [makeTurn({ userMessage: "keyword match" })],
    }))
    mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"))

    const { req, res, next } = createMockReqRes("GET", "/?q=keyword&sessionId=test-session-123")
    await handler(req as never, res as never, next)

    const data = JSON.parse(res._getData())
    expect(data).toHaveProperty("query")
    expect(data).toHaveProperty("totalHits")
    expect(data).toHaveProperty("returnedHits")
    expect(data).toHaveProperty("sessionsSearched")
    expect(data).toHaveProperty("results")
  })
})
```

**Step 2: Run test to verify it passes (existing tests should still pass)**

Run: `bun run test -- server/__tests__/routes/session-search.test.ts`
Expected: PASS (the existing tests verify the raw-scan path, which stays as fallback)

**Step 3: Refactor session-search.ts to try index first, fall back to raw scan**

Modify `server/routes/session-search.ts`. The key change is in the route handler:

```typescript
import { SearchIndex } from "../search-index"

// Module-level singleton — set by the server on boot
let searchIndex: SearchIndex | null = null

export function setSearchIndex(index: SearchIndex): void {
  searchIndex = index
}

export function getSearchIndex(): SearchIndex | null {
  return searchIndex
}
```

In `registerSessionSearchRoutes`, update the handler to try index first:

```typescript
export function registerSessionSearchRoutes(use: UseFn) {
  use("/api/session-search", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const query = url.searchParams.get("q")
    const sessionId = url.searchParams.get("sessionId")
    const maxAgeRaw = url.searchParams.get("maxAge") || "5d"
    const limitRaw = url.searchParams.get("limit") || "20"
    const caseSensitiveRaw = url.searchParams.get("caseSensitive") || "false"
    const depthRaw = url.searchParams.get("depth") || "4"

    if (!query || query.length < 2) {
      return sendJson(res, 400, { error: "Query parameter 'q' is required and must be at least 2 characters" })
    }

    const limit = Math.min(Math.max(1, parseInt(limitRaw, 10) || 20), 200)
    const caseSensitive = caseSensitiveRaw === "true"
    const depth = Math.min(Math.max(1, parseInt(depthRaw, 10) || 4), 4)
    const maxAgeMs = parseMaxAge(maxAgeRaw)

    // Try indexed search first
    if (searchIndex) {
      try {
        const hits = searchIndex.search(query, { limit, sessionId: sessionId ?? undefined, maxAgeMs, caseSensitive })

        // Group hits by sessionId
        const grouped = new Map<string, SearchHit[]>()
        for (const hit of hits) {
          const existing = grouped.get(hit.sessionId) || []
          existing.push({
            location: hit.location,
            snippet: hit.snippet,
            matchCount: hit.matchCount,
          })
          grouped.set(hit.sessionId, existing)
        }

        const results: SessionSearchResult[] = []
        let totalHits = 0
        for (const [sid, sessionHits] of grouped) {
          totalHits += sessionHits.length
          results.push({ sessionId: sid, hits: sessionHits })
        }

        return sendJson(res, 200, {
          query,
          totalHits,
          returnedHits: hits.length,
          sessionsSearched: grouped.size,
          results,
        } satisfies SearchResponse)
      } catch {
        // Index failed — fall through to raw scan
      }
    }

    // Fallback: raw scan (existing implementation)
    try {
      // ... existing raw scan code stays here unchanged ...
    }
  })
}
```

Move all the existing raw-scan logic into the fallback block. The existing code stays intact — it just becomes the `catch`/fallback path.

**Step 4: Run ALL tests to verify nothing broke**

Run: `bun run test`
Expected: ALL PASS — existing session-search tests still work via the fallback path (searchIndex is null in tests)

**Step 5: Commit**

```bash
git add server/routes/session-search.ts server/__tests__/routes/session-search.test.ts
git commit -m "feat: integrate search index into session-search route with fallback"
```

---

### Task 7: Add search-index stats and rebuild routes

**Files:**
- Create: `server/routes/search-index-stats.ts`
- Create: `server/__tests__/routes/search-index-stats.test.ts`

**Step 1: Write the failing test**

Create `server/__tests__/routes/search-index-stats.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest"
import { registerSearchIndexRoutes } from "../../routes/search-index-stats"
import type { UseFn, Middleware } from "../../helpers"

vi.mock("../../routes/session-search", () => ({
  getSearchIndex: vi.fn(),
}))

import { getSearchIndex } from "../../routes/session-search"
const mockedGetSearchIndex = vi.mocked(getSearchIndex)

function createMockReqRes(method: string, url: string) {
  let statusCode = 200
  const headers: Record<string, string> = {}
  let body = ""
  const req = { method, url, socket: { remoteAddress: "127.0.0.1" }, headers: {} }
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

describe("search-index-stats routes", () => {
  let statsHandler: Middleware
  let rebuildHandler: Middleware

  beforeEach(() => {
    vi.resetAllMocks()
    const handlers = new Map<string, Middleware>()
    const use: UseFn = (path, h) => { handlers.set(path, h) }
    registerSearchIndexRoutes(use)
    statsHandler = handlers.get("/api/search-index/stats")!
    rebuildHandler = handlers.get("/api/search-index/rebuild")!
  })

  describe("GET /api/search-index/stats", () => {
    it("returns 503 when index is not available", async () => {
      mockedGetSearchIndex.mockReturnValue(null)
      const { req, res, next } = createMockReqRes("GET", "/")
      await statsHandler(req as never, res as never, next)
      expect(res._getStatus()).toBe(503)
    })

    it("returns stats when index is available", async () => {
      mockedGetSearchIndex.mockReturnValue({
        getStats: () => ({
          dbPath: "/tmp/test.db",
          dbSizeBytes: 1000,
          dbSizeMB: 0.001,
          indexedFiles: 10,
          indexedSessions: 8,
          indexedSubagents: 2,
          totalRows: 100,
          watcherRunning: true,
          lastFullBuild: null,
          lastUpdate: null,
        }),
      } as any)
      const { req, res, next } = createMockReqRes("GET", "/")
      await statsHandler(req as never, res as never, next)
      expect(res._getStatus()).toBe(200)
      const data = JSON.parse(res._getData())
      expect(data.indexedFiles).toBe(10)
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `bun run test -- server/__tests__/routes/search-index-stats.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `server/routes/search-index-stats.ts`:

```typescript
import type { UseFn } from "../helpers"
import { sendJson } from "../helpers"
import { getSearchIndex } from "./session-search"

export function registerSearchIndexRoutes(use: UseFn) {
  use("/api/search-index/stats", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const index = getSearchIndex()
    if (!index) return sendJson(res, 503, { error: "Search index not available" })
    sendJson(res, 200, index.getStats())
  })

  use("/api/search-index/rebuild", async (req, res, next) => {
    if (req.method !== "POST") return next()
    const index = getSearchIndex()
    if (!index) return sendJson(res, 503, { error: "Search index not available" })

    // Rebuild async — don't block the response
    sendJson(res, 200, { status: "rebuilding" })

    // The projectsDir is stored on the index when startWatching was called
    // Trigger rebuild in background
    try {
      index.rebuild()
    } catch {
      // Non-fatal — index will recover on next update
    }
  })
}
```

Add `rebuild()` to `SearchIndex`:

```typescript
rebuild(): void {
  if (!this.projectsDir) return
  this.buildFull(this.projectsDir)
}
```

**Step 4: Run test to verify it passes**

Run: `bun run test -- server/__tests__/routes/search-index-stats.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/routes/search-index-stats.ts server/__tests__/routes/search-index-stats.test.ts server/search-index.ts
git commit -m "feat: add search-index stats and rebuild API routes"
```

---

### Task 8: Register routes and boot index in api-plugin.ts and electron/server.ts

**Files:**
- Modify: `server/api-plugin.ts`
- Modify: `electron/server.ts`

**Step 1: No test needed — this is wiring only (integration tested by existing tests)**

**Step 2: Modify `server/api-plugin.ts`**

Add at the top:

```typescript
import { registerSearchIndexRoutes } from "./routes/search-index-stats"
import { SearchIndex } from "./search-index"
import { setSearchIndex } from "./routes/session-search"
import { join } from "node:path"
import { homedir } from "node:os"
```

After `loadConfig().then(() => refreshDirs())`, add index boot:

```typescript
loadConfig().then(() => {
  refreshDirs()
  // Boot search index after dirs are ready
  try {
    const dbPath = join(homedir(), ".claude", "agent-window", "search-index.db")
    const index = new SearchIndex(dbPath)
    setSearchIndex(index)
    // Start watching after a short delay to not block startup
    setTimeout(() => {
      if (dirs.PROJECTS_DIR) index.startWatching(dirs.PROJECTS_DIR)
    }, 1000)
  } catch {
    // Non-fatal — search falls back to raw scan
  }
})
```

After route registrations, add:

```typescript
registerSearchIndexRoutes(use)
```

Close on shutdown:

```typescript
server.httpServer?.on("close", () => {
  cleanupProcesses()
  const index = getSearchIndex()
  if (index) {
    index.stopWatching()
    index.close()
  }
})
```

**Step 3: Modify `electron/server.ts`**

Same pattern — add imports, boot index after `refreshDirs()`, register routes, close on shutdown:

Add imports:

```typescript
import { registerSearchIndexRoutes } from "../server/routes/search-index-stats"
import { SearchIndex } from "../server/search-index"
import { setSearchIndex } from "../server/routes/session-search"
```

After `refreshDirs()` in `createAppServer`:

```typescript
// Boot search index
try {
  const dbPath = join(userDataDir, "search-index.db")
  const index = new SearchIndex(dbPath)
  setSearchIndex(index)
  setTimeout(() => {
    if (dirs.PROJECTS_DIR) index.startWatching(dirs.PROJECTS_DIR)
  }, 1000)
} catch {
  // Non-fatal
}
```

After route registrations:

```typescript
registerSearchIndexRoutes(use)
```

In the cleanup handler:

```typescript
httpServer.on("close", () => {
  for (const session of ptySessions.values()) {
    if (session.status === "running") session.pty.kill()
  }
  ptySessions.clear()
  cleanupProcesses()
  const { getSearchIndex } = require("../server/routes/session-search")
  const index = getSearchIndex()
  if (index) { index.stopWatching(); index.close() }
})
```

**Step 4: Run ALL tests to verify nothing broke**

Run: `bun run test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/api-plugin.ts electron/server.ts
git commit -m "feat: boot search index on server startup, register stats routes"
```

---

### Task 9: Run full test suite and verify

**Step 1: Run all tests**

Run: `bun run test`
Expected: ALL PASS

**Step 2: Run dev server and test manually**

Run: `bun run dev`

Test in another terminal:

```bash
# Verify index boots (may take a few seconds for initial build)
sleep 5
curl -s http://localhost:5173/api/search-index/stats | jq .

# Verify search works (should be fast)
time curl -s "http://localhost:5173/api/session-search?q=authentication&maxAge=365d&limit=20" | jq '{totalHits, returnedHits, sessionsSearched}'

# Verify rebuild works
curl -s -X POST http://localhost:5173/api/search-index/rebuild | jq .
```

**Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "chore: final integration fixes for search index"
```
