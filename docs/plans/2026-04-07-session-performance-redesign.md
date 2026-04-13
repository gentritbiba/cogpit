# Session Performance Redesign

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate UI freezes when switching sessions and during heavy bash output by moving parsing off the main thread, loading sessions bottom-first, caching recently viewed sessions, and lazy-loading older turns on scroll-up.

**Architecture:** Web Worker handles all JSONL parsing (both initial and incremental). Server gains a `?tail=N` endpoint that reads files from the end. Frontend caches last 5 parsed sessions in an LRU map. VirtualizedTimeline triggers lazy-load of older turns when user scrolls near the top. Electron guard middleware is optimized to stop calling `refreshDirs()` on every request.

**Tech Stack:** Web Workers (native, Vite handles bundling with `?worker` import), `@tanstack/react-virtual` (already installed), Node.js `fs` for reverse-read.

---

## Task 1: Web Worker Parser [DONE — iteration 1]

### Files:
- Create: `src/workers/session-parser.worker.ts`
- Create: `src/hooks/useParserWorker.ts`
- Modify: `src/lib/parser.ts` (no changes to logic, but exports need to work in worker context)

### Step 1: Create the Web Worker file

Create `src/workers/session-parser.worker.ts`:

```typescript
import { parseSession, parseSessionAppend } from "@/lib/parser"
import type { ParsedSession } from "@/lib/types"

export type WorkerRequest =
  | { type: "parse"; id: number; text: string }
  | { type: "append"; id: number; existing: ParsedSession; newText: string }

export type WorkerResponse =
  | { type: "result"; id: number; session: ParsedSession }
  | { type: "error"; id: number; error: string }

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    let session: ParsedSession
    if (msg.type === "parse") {
      session = parseSession(msg.text)
    } else {
      session = parseSessionAppend(msg.existing, msg.newText)
    }
    self.postMessage({ type: "result", id: msg.id, session } satisfies WorkerResponse)
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse)
  }
}
```

### Step 2: Create the `useParserWorker` hook

Create `src/hooks/useParserWorker.ts`:

```typescript
import { useRef, useEffect, useCallback } from "react"
import type { ParsedSession } from "@/lib/types"
import type { WorkerRequest, WorkerResponse } from "@/workers/session-parser.worker"

type PendingRequest = {
  resolve: (session: ParsedSession) => void
  reject: (error: Error) => void
}

export function useParserWorker() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<number, PendingRequest>>(new Map())
  const nextIdRef = useRef(0)

  useEffect(() => {
    const worker = new Worker(
      new URL("@/workers/session-parser.worker.ts", import.meta.url),
      { type: "module" }
    )

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      const pending = pendingRef.current.get(msg.id)
      if (!pending) return
      pendingRef.current.delete(msg.id)

      if (msg.type === "result") {
        pending.resolve(msg.session)
      } else {
        pending.reject(new Error(msg.error))
      }
    }

    worker.onerror = (err) => {
      // Reject all pending requests on worker crash
      for (const [id, pending] of pendingRef.current) {
        pending.reject(new Error(`Worker error: ${err.message}`))
        pendingRef.current.delete(id)
      }
    }

    workerRef.current = worker

    return () => {
      worker.terminate()
      workerRef.current = null
      // Reject any remaining pending requests
      for (const [, pending] of pendingRef.current) {
        pending.reject(new Error("Worker terminated"))
      }
      pendingRef.current.clear()
    }
  }, [])

  const parse = useCallback((text: string): Promise<ParsedSession> => {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current
      if (!worker) {
        // Fallback: import parser directly (shouldn't happen in practice)
        import("@/lib/parser").then(({ parseSession }) => {
          resolve(parseSession(text))
        }).catch(reject)
        return
      }
      const id = nextIdRef.current++
      pendingRef.current.set(id, { resolve, reject })
      worker.postMessage({ type: "parse", id, text } satisfies WorkerRequest)
    })
  }, [])

  const append = useCallback(
    (existing: ParsedSession, newText: string): Promise<ParsedSession> => {
      return new Promise((resolve, reject) => {
        const worker = workerRef.current
        if (!worker) {
          import("@/lib/parser").then(({ parseSessionAppend }) => {
            resolve(parseSessionAppend(existing, newText))
          }).catch(reject)
          return
        }
        const id = nextIdRef.current++
        pendingRef.current.set(id, { resolve, reject })
        worker.postMessage({ type: "append", id, existing, newText } satisfies WorkerRequest)
      })
    },
    []
  )

  return { parse, append }
}
```

### Step 3: Verify worker builds with Vite

Run: `bun run build 2>&1 | head -20`

Vite handles `new Worker(new URL(...), { type: "module" })` natively. The `@` alias resolves via `vite.config.ts` resolve alias. No Vite config changes needed.

### Step 4: Commit

```bash
git add src/workers/session-parser.worker.ts src/hooks/useParserWorker.ts
git commit -m "feat: add Web Worker for off-thread session parsing"
```

---

## Task 2: Session Cache

### Files:
- Create: `src/lib/sessionCache.ts`

### Step 1: Create the LRU session cache

Create `src/lib/sessionCache.ts`:

```typescript
import type { ParsedSession } from "./types"

interface CacheEntry {
  parsed: ParsedSession
  source: { dirName: string; fileName: string; rawText: string; agentKind?: "claude" | "codex" }
  /** Byte offset for chunked loading — how far back we've fetched */
  nextByteOffset: number
  /** Whether there are older turns available on the server */
  hasMore: boolean
  /** Timestamp for LRU eviction */
  lastAccessed: number
}

const MAX_ENTRIES = 5

class SessionCache {
  private entries = new Map<string, CacheEntry>()

  private key(dirName: string, fileName: string): string {
    return `${dirName}/${fileName}`
  }

  get(dirName: string, fileName: string): CacheEntry | undefined {
    const k = this.key(dirName, fileName)
    const entry = this.entries.get(k)
    if (entry) {
      entry.lastAccessed = Date.now()
    }
    return entry
  }

  set(
    dirName: string,
    fileName: string,
    parsed: ParsedSession,
    source: CacheEntry["source"],
    nextByteOffset: number = 0,
    hasMore: boolean = false,
  ): void {
    const k = this.key(dirName, fileName)
    this.entries.set(k, {
      parsed,
      source,
      nextByteOffset,
      hasMore,
      lastAccessed: Date.now(),
    })
    this.evict()
  }

  /** Update a cached session in-place (e.g. after SSE append or scroll-up load) */
  update(dirName: string, fileName: string, updates: Partial<Pick<CacheEntry, "parsed" | "nextByteOffset" | "hasMore">>): void {
    const k = this.key(dirName, fileName)
    const entry = this.entries.get(k)
    if (entry) {
      Object.assign(entry, updates)
      entry.lastAccessed = Date.now()
    }
  }

  /** Update the rawText on a cached entry (e.g. after SSE streaming adds content) */
  updateRawText(dirName: string, fileName: string, rawText: string): void {
    const k = this.key(dirName, fileName)
    const entry = this.entries.get(k)
    if (entry) {
      entry.source = { ...entry.source, rawText }
    }
  }

  evict(dirName?: string, fileName?: string): void {
    if (dirName && fileName) {
      this.entries.delete(this.key(dirName, fileName))
      return
    }
    // LRU eviction when over capacity
    while (this.entries.size > MAX_ENTRIES) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [key, entry] of this.entries) {
        if (entry.lastAccessed < oldestTime) {
          oldestTime = entry.lastAccessed
          oldestKey = key
        }
      }
      if (oldestKey) this.entries.delete(oldestKey)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Singleton session cache shared across all hooks */
export const sessionCache = new SessionCache()
```

### Step 2: Commit

```bash
git add src/lib/sessionCache.ts
git commit -m "feat: add LRU session cache for instant switching"
```

---

## Task 3: Bottom-First Server Endpoint [DONE — iteration 3]

### Files:
- Modify: `server/routes/projects/index.ts:265-305` (the `GET /api/sessions/:dirName/:fileName` handler)

### Step 1: Add the reverse-read utility

Add this function near the top of `server/routes/projects/index.ts` (after imports):

```typescript
import { open as fsOpen } from "node:fs/promises"

/**
 * Read the last `byteCount` bytes of a file, split into JSONL lines.
 * Returns { lines, byteOffset } where byteOffset is where these lines start.
 */
async function readTail(
  filePath: string,
  byteCount: number
): Promise<{ lines: string[]; byteOffset: number; totalSize: number }> {
  const fh = await fsOpen(filePath, "r")
  try {
    const fileStat = await fh.stat()
    const totalSize = fileStat.size
    const readStart = Math.max(0, totalSize - byteCount)
    const readLen = totalSize - readStart
    const buf = Buffer.alloc(readLen)
    await fh.read(buf, 0, readLen, readStart)

    const raw = buf.toString("utf-8")
    const parts = raw.split("\n")

    // First element may be a partial line (we sliced mid-line)
    if (readStart > 0) {
      parts.shift()
    }

    const lines = parts.filter((l) => l.trim())
    // Byte offset of the first complete line we return
    const firstLineOffset = readStart > 0
      ? readStart + raw.indexOf("\n") + 1
      : 0

    return { lines, byteOffset: firstLineOffset, totalSize }
  } finally {
    await fh.close()
  }
}

/**
 * Read JSONL lines from a file between two byte offsets.
 */
async function readRange(
  filePath: string,
  startOffset: number,
  endOffset: number
): Promise<string[]> {
  const fh = await fsOpen(filePath, "r")
  try {
    const readLen = endOffset - startOffset
    if (readLen <= 0) return []
    const buf = Buffer.alloc(readLen)
    await fh.read(buf, 0, readLen, startOffset)

    const raw = buf.toString("utf-8")
    const parts = raw.split("\n")

    // First element may be partial if startOffset isn't at a line boundary
    if (startOffset > 0) {
      parts.shift()
    }

    return parts.filter((l) => l.trim())
  } finally {
    await fh.close()
  }
}

/**
 * Extract session metadata (sessionId, cwd, model, etc.) from the first few
 * KB of a JSONL file. Reads only the header — avoids loading the full file.
 */
async function readSessionHeader(
  filePath: string
): Promise<{ lines: string[]; bytesRead: number }> {
  const HEADER_BYTES = 4096
  const fh = await fsOpen(filePath, "r")
  try {
    const fileStat = await fh.stat()
    const readLen = Math.min(HEADER_BYTES, fileStat.size)
    const buf = Buffer.alloc(readLen)
    await fh.read(buf, 0, readLen, 0)
    const raw = buf.toString("utf-8")
    const parts = raw.split("\n")

    // Drop last partial line
    if (readLen < fileStat.size) parts.pop()

    return {
      lines: parts.filter((l) => l.trim()),
      bytesRead: readLen,
    }
  } finally {
    await fh.close()
  }
}
```

### Step 2: Modify the session file serving handler

Replace the existing handler at line 265-305 with support for `?tail` and `?before` query params:

```typescript
    } else if (parts.length >= 2) {
      // Serve session file content (supports nested paths like sessionId/subagents/file.jsonl)
      const dirName = decodeURIComponent(parts[0])
      const fileParts = parts.slice(1).map(decodeURIComponent)
      const fileName = fileParts.join("/")

      if (!fileName.endsWith(".jsonl")) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Only .jsonl files" }))
        return
      }

      let filePath = await resolveSessionFilePath(dirName, fileName)

      // For Codex sessions, resolve virtual paths by session ID lookup.
      if (!filePath && isCodexDirName(dirName)) {
        const idMatch = fileName.match(/\/subagents\/agent-([^.]+)\.jsonl$/)
          ?? fileName.match(/^([^/]+)\.jsonl$/)
        if (idMatch) {
          const resolved = await findJsonlPath(idMatch[1])
          if (resolved && resolved.startsWith(CODEX_SESSIONS_DIR + "/")) {
            filePath = resolved
          }
        }
      }

      if (!filePath) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const url = new URL(req.url || "/", "http://localhost")
      const tailParam = url.searchParams.get("tail")
      const beforeParam = url.searchParams.get("before")

      try {
        if (tailParam) {
          // Bottom-first: return last N turns worth of content
          // We read a generous byte range and let the client parse turns.
          // 64KB per requested turn is a safe overestimate.
          const requestedTurns = Math.max(1, Math.min(parseInt(tailParam, 10) || 30, 200))
          const bytesToRead = requestedTurns * 65536 // 64KB per turn estimate
          const { lines, byteOffset, totalSize } = await readTail(filePath, bytesToRead)

          // Also grab header metadata (first few lines of file)
          const header = await readSessionHeader(filePath)

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            headerLines: header.lines,
            tailLines: lines,
            byteOffset,
            totalSize,
            hasMore: byteOffset > header.bytesRead,
          }))
        } else if (beforeParam) {
          // Pagination: return lines before a given byte offset
          const endOffset = Math.max(0, parseInt(beforeParam, 10) || 0)
          const count = Math.max(1, Math.min(parseInt(url.searchParams.get("count") || "30", 10), 200))
          const bytesToRead = count * 65536
          const startOffset = Math.max(0, endOffset - bytesToRead)
          const lines = await readRange(filePath, startOffset, endOffset)

          // Read header too so metadata is always available
          const header = await readSessionHeader(filePath)

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            headerLines: header.lines,
            lines,
            byteOffset: startOffset,
            hasMore: startOffset > header.bytesRead,
          }))
        } else {
          // Legacy: full file content (backwards compatible)
          const content = await readFile(filePath, "utf-8")
          res.setHeader("Content-Type", "text/plain")
          res.end(content)
        }
      } catch {
        res.statusCode = 404
        res.end(JSON.stringify({ error: "File not found" }))
      }
    } else {
      next()
    }
```

### Step 3: Commit

```bash
git add server/routes/projects/index.ts
git commit -m "feat: add tail/before params for bottom-first session loading"
```

---

## Task 4: Wire Up Frontend — Replace `fetchAndParse` with Worker + Cache + Tail

### Files:
- Modify: `src/hooks/useSessionActions.ts` (replace `fetchAndParse`, integrate cache + worker)
- Modify: `src/hooks/useLiveSession.ts` (use worker for parsing, update cache)
- Modify: `src/App.tsx:257-260` (pass worker to `useLiveSession`)

### Step 1: Rewrite `useSessionActions.ts`

The new `fetchAndParse` uses the `?tail` endpoint + worker. Cache check comes first.

```typescript
import { useState, useCallback, type Dispatch } from "react"
import type { SessionAction } from "./useSessionState"
import type { SessionTeamContext } from "./useSessionTeam"
import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "./useLiveSession"
import type { TeamMember } from "@/lib/team-types"
import type { MobileTab } from "@/components/MobileNav"
import { parseSession } from "@/lib/parser"
import { authFetch } from "@/lib/auth"
import { cacheTurnCount } from "@/lib/turnCountCache"
import { agentKindFromDirName } from "@/lib/sessionSource"
import { sessionCache } from "@/lib/sessionCache"

interface TailResponse {
  headerLines: string[]
  tailLines: string[]
  byteOffset: number
  totalSize: number
  hasMore: boolean
}

interface UseSessionActionsOpts {
  dispatch: Dispatch<SessionAction>
  isMobile: boolean
  teamContext: SessionTeamContext | null
  scrollToBottomInstant: () => void
  resetTurnCount: (count: number) => void
  onBeforeSwitch?: () => void
  workerParse: (text: string) => Promise<ParsedSession>
}

/** Fetch a session tail (last N turns) and parse via worker. */
async function fetchTailAndParse(
  dirName: string,
  fileName: string,
  workerParse: (text: string) => Promise<ParsedSession>,
  errorLabel: string,
): Promise<{
  parsed: ParsedSession
  source: SessionSource
  byteOffset: number
  hasMore: boolean
}> {
  const res = await authFetch(
    `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}?tail=30`
  )
  if (!res.ok) throw new Error(`Failed to load ${errorLabel} (${res.status})`)
  const data: TailResponse = await res.json()

  // Combine header + tail lines into JSONL text for parsing
  // Header lines provide metadata (sessionId, cwd, model, etc.)
  // Deduplicate: tail might overlap with header if file is small
  const headerSet = new Set(data.headerLines)
  const uniqueTail = data.tailLines.filter((l) => !headerSet.has(l))
  const text = [...data.headerLines, ...uniqueTail].join("\n")

  const parsed = await workerParse(text)

  return {
    parsed,
    source: { dirName, fileName, rawText: text, agentKind: agentKindFromDirName(dirName) },
    byteOffset: data.byteOffset,
    hasMore: data.hasMore,
  }
}

/** Legacy full fetch for team member switches and other paths that need full content. */
async function fetchFullAndParse(
  dirName: string,
  fileName: string,
  workerParse: (text: string) => Promise<ParsedSession>,
  errorLabel: string,
): Promise<{ parsed: ParsedSession; source: SessionSource }> {
  const res = await authFetch(
    `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`
  )
  if (!res.ok) throw new Error(`Failed to load ${errorLabel} (${res.status})`)
  const text = await res.text()
  const parsed = await workerParse(text)
  return {
    parsed,
    source: { dirName, fileName, rawText: text, agentKind: agentKindFromDirName(dirName) },
  }
}

export function useSessionActions({
  dispatch,
  isMobile,
  teamContext,
  scrollToBottomInstant,
  resetTurnCount,
  onBeforeSwitch,
  workerParse,
}: UseSessionActionsOpts) {
  const [loadError, setLoadError] = useState<string | null>(null)

  const handleLoadSession = useCallback(
    (parsed: ParsedSession, source: SessionSource) => {
      setLoadError(null)
      dispatch({ type: "LOAD_SESSION", session: parsed, source, isMobile })
      resetTurnCount(parsed.turns.length)
      cacheTurnCount(parsed.sessionId, parsed.turns.length)
      scrollToBottomInstant()
    },
    [dispatch, isMobile, resetTurnCount, scrollToBottomInstant]
  )

  const handleDashboardSelect = useCallback(
    async (dirName: string, fileName: string) => {
      onBeforeSwitch?.()
      setLoadError(null)

      // 1. Check cache first — instant switch
      const cached = sessionCache.get(dirName, fileName)
      if (cached) {
        handleLoadSession(cached.parsed, cached.source)
        return
      }

      // 2. Cache miss — fetch tail via worker
      try {
        const { parsed, source, byteOffset, hasMore } =
          await fetchTailAndParse(dirName, fileName, workerParse, "session")
        sessionCache.set(dirName, fileName, parsed, source, byteOffset, hasMore)
        handleLoadSession(parsed, source)
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load session")
      }
    },
    [handleLoadSession, onBeforeSwitch, workerParse]
  )

  const handleOpenSessionFromTeam = useCallback(
    async (dirName: string, fileName: string, memberName?: string) => {
      onBeforeSwitch?.()
      setLoadError(null)
      try {
        const { parsed, source } = await fetchFullAndParse(dirName, fileName, workerParse, "team session")
        dispatch({
          type: "LOAD_SESSION_FROM_TEAM",
          session: parsed,
          source,
          memberName,
          isMobile,
        })
        resetTurnCount(parsed.turns.length)
        scrollToBottomInstant()
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load team session")
      }
    },
    [dispatch, isMobile, resetTurnCount, scrollToBottomInstant, onBeforeSwitch, workerParse]
  )

  const handleTeamMemberSwitch = useCallback(
    async (member: TeamMember) => {
      if (!teamContext) return
      onBeforeSwitch?.()
      setLoadError(null)
      dispatch({ type: "SET_LOADING_MEMBER", name: member.name })
      try {
        const lookupRes = await authFetch(
          `/api/team-member-session/${encodeURIComponent(teamContext.teamName)}/${encodeURIComponent(member.name)}`
        )
        if (!lookupRes.ok) throw new Error(`Failed to find session for ${member.name}`)
        const { dirName, fileName } = await lookupRes.json()

        const { parsed, source } = await fetchFullAndParse(dirName, fileName, workerParse, `session for ${member.name}`)
        dispatch({
          type: "SWITCH_TEAM_MEMBER",
          session: parsed,
          source: source,
          memberName: member.name,
        })
        resetTurnCount(parsed.turns.length)
        scrollToBottomInstant()
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to switch team member")
      } finally {
        dispatch({ type: "SET_LOADING_MEMBER", name: null })
      }
    },
    [dispatch, teamContext, resetTurnCount, scrollToBottomInstant, onBeforeSwitch, workerParse]
  )

  // ... rest of handlers unchanged (handleSelectTeam, handleBackFromTeam, etc.)
```

Key changes from original:
- `fetchAndParse` replaced by `fetchTailAndParse` (uses `?tail=30` + worker)
- `handleDashboardSelect` checks cache before fetching
- `workerParse` passed in from the hook that owns the worker
- Team member switches use `fetchFullAndParse` (full file, since they aren't performance-sensitive)

### Step 2: Modify `useLiveSession.ts` to use worker for parsing

Replace the synchronous `parseSession`/`parseSessionAppend` calls with the worker:

The key change is in the `es.onmessage` handler. Instead of:
```typescript
sessionRef.current = parseSessionAppend(sessionRef.current, newText)
```

It becomes:
```typescript
// Queue worker parse — non-blocking
workerAppendRef.current(sessionRef.current, newText).then((result) => {
  sessionRef.current = result
  // Update cache
  if (dirName && fileName) {
    sessionCache.update(dirName, fileName, { parsed: result })
    sessionCache.updateRawText(dirName, fileName, textRef.current)
  }
  if (!pendingUpdate) {
    pendingUpdate = true
    rafId = requestAnimationFrame(flushUpdate)
  }
})
```

The function signature gains a `workerAppend` parameter:
```typescript
export function useLiveSession(
  source: SessionSource | null,
  onUpdate: (session: ParsedSession) => void,
  workerParse: (text: string) => Promise<ParsedSession>,
  workerAppend: (existing: ParsedSession, newText: string) => Promise<ParsedSession>,
  onReconnect?: () => void
)
```

### Step 3: Wire worker into `App.tsx`

In `App.tsx`, add the worker hook and pass it through:

```typescript
// Near other hook calls (around line 125)
const { parse: workerParse, append: workerAppend } = useParserWorker()

// Pass to useSessionActions (around line 510)
const actions = useSessionActions({
  dispatch,
  isMobile,
  teamContext,
  scrollToBottomInstant,
  resetTurnCount,
  onBeforeSwitch: /* ... */,
  workerParse,  // NEW
})

// Pass to useLiveSession (around line 257)
const { isLive, sseState, isCompacting } = useLiveSession(
  state.sessionSource,
  (updated) => { startTransition(() => { dispatch({ type: "UPDATE_SESSION", session: updated }) }) },
  workerParse,    // NEW
  workerAppend,   // NEW
  onReconnect,
)
```

### Step 4: Run tests

Run: `bun run test`
Expected: All existing tests pass. The parser tests use `parseSession` directly (not the worker), so they're unaffected.

### Step 5: Commit

```bash
git add src/hooks/useSessionActions.ts src/hooks/useLiveSession.ts src/App.tsx
git commit -m "feat: wire web worker + cache into session loading pipeline"
```

---

## Task 5: Scroll-Up Lazy Loading

### Files:
- Create: `src/hooks/useChunkedSession.ts`
- Modify: `src/components/timeline/VirtualizedTimeline.tsx` (add scroll-up trigger)
- Modify: `src/components/ConversationTimeline.tsx` (pass loadMore props)

### Step 1: Create `useChunkedSession` hook

Create `src/hooks/useChunkedSession.ts`:

```typescript
import { useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import type { ParsedSession, Turn } from "@/lib/types"

interface BeforeResponse {
  headerLines: string[]
  lines: string[]
  byteOffset: number
  hasMore: boolean
}

interface UseChunkedSessionOpts {
  dirName: string | null
  fileName: string | null
  workerParse: (text: string) => Promise<ParsedSession>
  onPrependTurns: (olderTurns: Turn[], hasMore: boolean, nextByteOffset: number) => void
}

export function useChunkedSession({
  dirName,
  fileName,
  workerParse,
  onPrependTurns,
}: UseChunkedSessionOpts) {
  const loadingRef = useRef(false)

  const loadMore = useCallback(async () => {
    if (!dirName || !fileName || loadingRef.current) return
    const cached = sessionCache.get(dirName, fileName)
    if (!cached || !cached.hasMore) return

    loadingRef.current = true
    try {
      const res = await authFetch(
        `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}?before=${cached.nextByteOffset}&count=30`
      )
      if (!res.ok) return

      const data: BeforeResponse = await res.json()
      if (data.lines.length === 0) {
        sessionCache.update(dirName, fileName, { hasMore: false })
        return
      }

      // Parse the older lines into turns
      const text = [...data.headerLines, ...data.lines].join("\n")
      const olderParsed = await workerParse(text)

      // Update cache
      sessionCache.update(dirName, fileName, {
        hasMore: data.hasMore,
        nextByteOffset: data.byteOffset,
      })

      onPrependTurns(olderParsed.turns, data.hasMore, data.byteOffset)
    } finally {
      loadingRef.current = false
    }
  }, [dirName, fileName, workerParse, onPrependTurns])

  const hasMore = dirName && fileName
    ? (sessionCache.get(dirName, fileName)?.hasMore ?? false)
    : false

  return { loadMore, hasMore, isLoading: loadingRef.current }
}
```

### Step 2: Add scroll-up trigger to `VirtualizedTimeline.tsx`

Add to the `VirtualizedTimeline` component, after the virtualizer setup:

```typescript
interface TimelineInnerProps {
  filteredTurns: { turn: Turn; index: number }[]
  hasMore?: boolean
  onLoadMore?: () => void
}

// Inside VirtualizedTimeline component:
  // Scroll-up lazy loading trigger
  useEffect(() => {
    if (!hasMore || !onLoadMore) return
    const items = virtualizer.getVirtualItems()
    if (items.length === 0) return
    // When the first visible item is near the top, load more
    const firstVisible = items[0]
    if (firstVisible && firstVisible.index < 5) {
      onLoadMore()
    }
  }, [virtualizer.getVirtualItems(), hasMore, onLoadMore])
```

Also update the prop types for `NonVirtualTimeline` and pass through from `ConversationTimeline`.

### Step 3: Show loading indicator at top when fetching older turns

```typescript
// At the top of VirtualizedTimeline's render, before the virtual items:
{hasMore && (
  <div className="flex items-center justify-center py-4 text-muted-foreground text-xs">
    Loading older turns...
  </div>
)}
```

### Step 4: Wire into `ConversationTimeline.tsx`

Pass `hasMore` and `onLoadMore` through:

```typescript
export const ConversationTimeline = memo(function ConversationTimeline({
  chatScrollRef,
  hasMore,
  onLoadMore,
}: ConversationTimelineProps & { hasMore?: boolean; onLoadMore?: () => void }) {
  // ... existing code ...

  if (shouldVirtualize) {
    return (
      <VirtualizedTimeline
        filteredTurns={filteredTurns}
        scrollContainerRef={chatScrollRef}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
      />
    )
  }

  return <NonVirtualTimeline filteredTurns={filteredTurns} />
})
```

### Step 5: Commit

```bash
git add src/hooks/useChunkedSession.ts src/components/timeline/VirtualizedTimeline.tsx src/components/ConversationTimeline.tsx
git commit -m "feat: add scroll-up lazy loading for older turns"
```

---

## Task 6: Electron Optimizations

### Files:
- Modify: `electron/server.ts:70-79` (remove per-request `refreshDirs()`)

### Step 1: Move `refreshDirs()` out of per-request middleware

In `electron/server.ts`, the guard middleware at line 70 calls `refreshDirs()` on every API request. This reads the config file from disk every time. Move it to happen only when config changes.

Replace:
```typescript
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/config") || req.path.startsWith("/notify")) return next()
    if (!getConfig()) {
      res.status(503).json({ error: "Not configured", code: "NOT_CONFIGURED" })
      return
    }
    refreshDirs()
    dirs.UNDO_DIR = join(userDataDir, "undo-history")
    next()
  })
```

With:
```typescript
  // Refresh dirs once at startup and when config changes (not per-request)
  dirs.UNDO_DIR = join(userDataDir, "undo-history")

  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/config") || req.path.startsWith("/notify")) return next()
    if (!getConfig()) {
      res.status(503).json({ error: "Not configured", code: "NOT_CONFIGURED" })
      return
    }
    next()
  })
```

Also apply the same change to `server/api-plugin.ts` if it has the same pattern.

### Step 2: Add `refreshDirs()` call to config change handler

Find the config update route and add `refreshDirs()` there so dirs only refresh when config actually changes, not on every request.

### Step 3: Run tests

Run: `bun run test`
Expected: All tests pass.

### Step 4: Commit

```bash
git add electron/server.ts server/api-plugin.ts
git commit -m "perf: remove per-request refreshDirs() from Electron middleware"
```

---

## Task 7: Integration — Wire Chunked Session into App

### Files:
- Modify: `src/App.tsx` (add `useChunkedSession`, handle turn prepend)
- Modify: `src/hooks/useSessionState.ts` (add `PREPEND_TURNS` action)

### Step 1: Add `PREPEND_TURNS` action to session reducer

In `src/hooks/useSessionState.ts`, add a new action type:

```typescript
// Add to SessionAction union:
| { type: "PREPEND_TURNS"; turns: Turn[] }

// Add case to reducer:
case "PREPEND_TURNS": {
  if (!state.session) return state
  return {
    ...state,
    session: {
      ...state.session,
      turns: [...action.turns, ...state.session.turns],
    },
  }
}
```

### Step 2: Wire `useChunkedSession` in `App.tsx`

```typescript
// After workerParse/workerAppend setup:
const handlePrependTurns = useCallback((olderTurns: Turn[], hasMore: boolean, nextByteOffset: number) => {
  dispatch({ type: "PREPEND_TURNS", turns: olderTurns })
  // Cache is already updated by useChunkedSession
}, [dispatch])

const chunkedSession = useChunkedSession({
  dirName: state.sessionSource?.dirName ?? null,
  fileName: state.sessionSource?.fileName ?? null,
  workerParse,
  onPrependTurns: handlePrependTurns,
})

// Pass to ConversationTimeline (in the ChatArea render):
<ConversationTimeline
  chatScrollRef={chatScrollRef}
  hasMore={chunkedSession.hasMore}
  onLoadMore={chunkedSession.loadMore}
/>
```

### Step 3: Update cache on live session updates

In the `useLiveSession` SSE handler, after the worker finishes appending, update the cache:

```typescript
// Already handled in Task 4 Step 2 — the workerAppend callback updates the cache.
// This step verifies that cache.update is called after each SSE append.
```

### Step 4: Run full test suite

Run: `bun run test`
Expected: All tests pass.

### Step 5: Run build

Run: `bun run build`
Expected: Build succeeds with no errors. Worker is bundled automatically by Vite.

### Step 6: Commit

```bash
git add src/App.tsx src/hooks/useSessionState.ts
git commit -m "feat: integrate chunked loading with session cache and scroll-up lazy load"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `src/workers/session-parser.worker.ts` | **NEW** — Web Worker that runs `parseSession`/`parseSessionAppend` off main thread |
| `src/hooks/useParserWorker.ts` | **NEW** — Hook to manage worker lifecycle and promise-based messaging |
| `src/lib/sessionCache.ts` | **NEW** — LRU cache (5 entries) for instant session switching |
| `src/hooks/useChunkedSession.ts` | **NEW** — Hook for scroll-up lazy loading of older turns |
| `server/routes/projects/index.ts` | **MODIFY** — Add `?tail=N` and `?before=offset` params for bottom-first loading |
| `src/hooks/useSessionActions.ts` | **MODIFY** — Use worker + cache + tail endpoint instead of synchronous parse |
| `src/hooks/useLiveSession.ts` | **MODIFY** — Use worker for incremental parsing, update cache |
| `src/hooks/useSessionState.ts` | **MODIFY** — Add `PREPEND_TURNS` reducer action |
| `src/components/timeline/VirtualizedTimeline.tsx` | **MODIFY** — Add scroll-up trigger for lazy loading |
| `src/components/ConversationTimeline.tsx` | **MODIFY** — Pass through `hasMore`/`onLoadMore` props |
| `src/App.tsx` | **MODIFY** — Wire worker, cache, chunked session hooks |
| `electron/server.ts` | **MODIFY** — Remove per-request `refreshDirs()` |
