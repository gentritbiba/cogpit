# Session Search Index Design

## Problem

The session search API (`/api/session-search`) scans raw JSONL files on every request. With 762 sessions + 2,030 subagent files (~1.3 GB on disk), a worst-case search (no matches, full scan) takes ~2.4 seconds. At 10x scale this becomes ~24 seconds — unacceptable.

## Solution

Add a persistent FTS5 search index using `bun:sqlite`. The index is a read-only sidecar derived from the JSONL source files. Searches drop from seconds to single-digit milliseconds.

### Benchmarks (current data)

| Operation | Current (raw scan) | With FTS5 index |
|---|---|---|
| Search (common query) | ~2.4s | ~5ms |
| Search (no matches) | ~2.4s | ~1ms |
| Search (200 results) | ~2.4s | ~3ms |
| Index build (one-time) | N/A | ~5-8s |
| Index size on disk | 0 | ~280-300 MB |

## Architecture

### Module: `server/search-index.ts`

Standalone `SearchIndex` class with three entry points:

- **`buildFull()`** — full rebuild from scratch. For CLI/MCP use.
- **`updateStale()`** — check mtimes, re-index only changed/new files. For on-demand use.
- **`startWatching()`** — calls `updateStale()` once, then watches for file changes. For server use.

The module is self-contained and portable — it can be called from the server, a future CLI tool, or an MCP server.

### Database

Single SQLite file at `~/.claude/agent-window/search-index.db`.

```sql
-- Track indexed files for staleness checks
CREATE TABLE indexed_files (
  file_path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  session_id TEXT NOT NULL,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT
);

-- FTS5 full-text search
CREATE VIRTUAL TABLE search_content USING fts5(
  session_id,
  location,
  content,
  tokenize = 'trigram'
);
```

WAL mode + `synchronous = NORMAL` for write performance.

### Indexed Content

Same fields the current raw-scan searches:

| Field | Location format |
|---|---|
| User message | `turn/{i}/userMessage` |
| Assistant message | `turn/{i}/assistantMessage` |
| Thinking blocks | `turn/{i}/thinking` |
| Tool call input | `turn/{i}/toolCall/{id}/input` |
| Tool call result | `turn/{i}/toolCall/{id}/result` |
| Subagent text | `agent/{agentId}/assistantMessage` |
| Subagent thinking | `agent/{agentId}/thinking` |
| Subagent tool I/O | `agent/{agentId}/toolCall/{id}/input\|result` |
| Compaction summary | `turn/{i}/compactionSummary` |

Subagent files are indexed recursively up to depth 4 (same as current search).

### Indexing Pipeline

Per file:

1. Read raw JSONL content
2. Parse via existing `parseSession()` — no parser duplication
3. Extract searchable fields with location strings
4. Delete old rows for this file from `search_content` (if re-indexing)
5. Insert all rows in a single transaction
6. Update `indexed_files` with new mtime

### File Watcher

On server boot, `startWatching()`:

1. Run `updateStale()` to catch changes while server was off
2. Start `fs.watch({ recursive: true })` on `~/.claude/projects/`
3. Debounce per-file with 2-second delay (JSONL files update frequently)
4. Filter: only react to `.jsonl` changes
5. Re-index changed file

Runs in the same process as the server. Non-fatal — if it crashes, search falls back to raw scan.

### Search Query Flow

When `/api/session-search` receives a request:

1. Check if index is available and healthy
2. If yes: query FTS5 with trigram match, group by session, format response
3. If no: fall back to existing raw-scan pipeline (kept as `rawScanSearch()`)

The caller sees the same response shape either way.

### API

**Existing (unchanged contract):**

`GET /api/session-search?q=...&sessionId=...&maxAge=...&limit=...&caseSensitive=...&depth=...`

Same params, same response shape. Internals swapped to index-backed.

**New — Index stats:**

`GET /api/search-index/stats`

```json
{
  "dbPath": "~/.claude/agent-window/search-index.db",
  "dbSizeBytes": 295000000,
  "dbSizeMB": 281.3,
  "indexedFiles": 2792,
  "indexedSessions": 762,
  "indexedSubagents": 2030,
  "totalRows": 168000,
  "watcherRunning": true,
  "lastFullBuild": "2026-03-05T14:30:00Z",
  "lastUpdate": "2026-03-05T15:12:33Z"
}
```

**New — Manual rebuild:**

`POST /api/search-index/rebuild`

Returns `{ status: "rebuilding" }` immediately. Rebuild runs async.

Both new endpoints registered in `api-plugin.ts` and `electron/server.ts`.

### Fallback

If the index is unavailable (DB missing, corrupt, mid-rebuild), the search route falls back to the existing raw-scan implementation transparently. No error to the caller.

The existing search logic is extracted into a `rawScanSearch()` function rather than deleted.

### Constraints

- **Bun-only** — uses `bun:sqlite` (ships with Bun, zero npm dependencies)
- **FTS5 trigram tokenizer** — supports substring matching (same as current `indexOf` behavior)
- **Read-only sidecar** — never modifies JSONL source files. Index is disposable and rebuildable.

## Files Changed

| File | Change |
|---|---|
| `server/search-index.ts` | New — SearchIndex class |
| `server/routes/session-search.ts` | Modify — swap internals to use index, keep raw-scan as fallback |
| `server/routes/search-index-stats.ts` | New — stats + rebuild endpoints |
| `server/api-plugin.ts` | Register new routes |
| `electron/server.ts` | Register new routes |
| `server/__tests__/routes/session-search.test.ts` | Update — test index path + fallback |
| `server/__tests__/search-index.test.ts` | New — unit tests for indexer |
