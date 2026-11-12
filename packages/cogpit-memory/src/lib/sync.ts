/**
 * Bring the tool index and the memory store up to date with the transcripts
 * on disk, newest first. A file either store needs is read and parsed once and
 * fed to both.
 */
import { parseSession } from "./parser"
import type { SearchIndex } from "./search-index"
import type { MemoryStore } from "./memory/store"
import { subagentTranscripts } from "./memory/reconcile"
import type { SourceFile } from "./memory/types"
import { allStores, type AgentSessionStore, type SessionFile } from "./stores"
import { readTranscriptTextSync } from "./transcriptFile"

export interface SyncSummary {
  /** Transcripts found on disk. */
  files: number
  /** Transcripts read and parsed in this run. */
  parsed: number
  toolIndexFiles: number
  memoryFiles: number
  chunks: { added: number; updated: number; removed: number }
  failed: number
  /** Stale transcripts left for a later run, by the time budget or the back-off. */
  pending: number
  /** The part of `pending` the stores have never seen. */
  unindexed: number
  durationMs: number
}

export interface SyncOptions {
  index: SearchIndex | null
  memory: MemoryStore | null
  /**
   * Stop starting files after this long, and skip a file whose last sync took
   * longer than the time left (its size, for a file never synced). No limit
   * when absent.
   */
  budgetMs?: number
  /**
   * Re-sync a transcript the memory store already has at most once per
   * max(1 min, 20 × its last sync), so a session that keeps writing is not
   * re-read by every search.
   */
  backOff?: boolean
  /** Sync this session's transcripts and its subagents' first, whatever the budget and back-off. */
  sessionId?: string
  /** Called after each parsed file. */
  onProgress?: (summary: SyncSummary) => void
  /** The clock, for tests. */
  now?: () => number
}

type ListedFile = SessionFile & { source: SourceFile }

export const BACK_OFF_MIN_MS = 60_000
export const BACK_OFF_FACTOR = 20
/** Assumed read, parse and write speed of a file never synced, in bytes per ms. */
const UNSYNCED_BYTES_PER_MS = 10_000

export function emptySyncSummary(): SyncSummary {
  return {
    files: 0, parsed: 0, toolIndexFiles: 0, memoryFiles: 0, chunks: { added: 0, updated: 0, removed: 0 }, failed: 0, pending: 0, unindexed: 0, durationMs: 0,
  }
}

function sourceFileOf(store: AgentSessionStore, file: SessionFile): SourceFile {
  return {
    path: file.path,
    mtimeMs: file.mtimeMs,
    size: file.size,
    sessionId: file.sessionId,
    instanceId: store.instanceId,
    agentKind: store.kind,
    isSubagent: file.isSubagent,
    parentSessionId: file.parentSessionId,
    agentId: file.agentId,
  }
}

/** Sync one parsed transcript into the memory store, counting into `summary`. */
export function syncIntoMemory(
  memory: MemoryStore,
  source: SourceFile,
  session: ReturnType<typeof parseSession>,
  hasSubagentTranscript: (agentId: string) => boolean,
  summary: SyncSummary,
  timing: { now?: number; elapsedMs?: number } = {},
): void {
  const result = memory.syncSession(source, session, { hasSubagentTranscript, ...timing })
  summary.memoryFiles++
  summary.chunks.added += result.added
  summary.chunks.updated += result.updated
  summary.chunks.removed += result.removed
}

export function listTranscripts(): ListedFile[] {
  return allStores().flatMap((store) => store.list(0).map((file) => ({ ...file, source: sourceFileOf(store, file) })))
}

/**
 * Sync what either store lacks: the given session first, then transcripts the
 * stores have never seen, then ones that changed since, each group newest
 * first.
 */
export function syncTranscripts(options: SyncOptions): SyncSummary {
  const now = options.now ?? Date.now
  const started = now()
  const summary = emptySyncSummary()
  const files = listTranscripts()
  summary.files = files.length
  const subagents = subagentTranscripts(files.map((file) => file.source))
  const indexed = options.index?.indexedFiles()
  const synced = options.memory?.syncedFiles()
  const stale = new Set(options.memory?.planSync(files.map((file) => file.source), synced).map((file) => file.path))
  const needsIndex = (file: ListedFile) => !!indexed && !((indexed.get(file.path) ?? -Infinity) >= file.mtimeMs)
  const known = (file: ListedFile) => (!synced || synced.has(file.path)) && (!indexed || indexed.has(file.path))
  const own = (file: ListedFile) => !!options.sessionId && (file.sessionId === options.sessionId || file.parentSessionId === options.sessionId)
  const expectedMs = (file: ListedFile) => synced?.get(file.path)?.syncMs ?? file.size / UNSYNCED_BYTES_PER_MS
  const indexedAt = !synced && options.backOff ? options.index?.indexedAt() : undefined
  const lastSyncAt = (file: ListedFile) => (synced ? synced.get(file.path)?.syncedAtMs : indexedAt?.get(file.path))
  const due = (file: ListedFile) => {
    const last = lastSyncAt(file)
    return !options.backOff || !known(file) || last === undefined || started - last >= Math.max(BACK_OFF_MIN_MS, BACK_OFF_FACTOR * expectedMs(file))
  }

  const work = files.filter((file) => needsIndex(file) || stale.has(file.path)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const ordered = [
    ...work.filter(own),
    ...work.filter((file) => !own(file) && !known(file)),
    ...work.filter((file) => !own(file) && known(file)),
  ]
  for (const file of ordered) {
    if (!own(file)) {
      const left = options.budgetMs === undefined ? Infinity : options.budgetMs - (now() - started)
      if (!due(file) || expectedMs(file) > left) {
        summary.pending++
        if (!known(file)) summary.unindexed++
        continue
      }
    }
    const fileStarted = now()
    let session: ReturnType<typeof parseSession>
    try {
      session = parseSession(readTranscriptTextSync(file.path), { skipStats: true })
    } catch {
      summary.failed++
      continue
    }
    summary.parsed++
    try {
      if (options.index && needsIndex(file)) {
        options.index.indexParsed(file, session)
        summary.toolIndexFiles++
      }
      if (options.memory && stale.has(file.path)) {
        syncIntoMemory(options.memory, file.source, session, subagents(file.sessionId), summary, { now: now(), elapsedMs: now() - fileStarted })
      }
    } catch {
      summary.failed++
    }
    options.onProgress?.(summary)
  }
  summary.durationMs = now() - started
  return summary
}

/** Build the tool index from scratch, feeding every parse to the memory store as well. */
export function rebuildToolIndex(index: SearchIndex, memory: MemoryStore | null): SyncSummary {
  const started = Date.now()
  const summary = emptySyncSummary()
  const files = memory ? listTranscripts() : []
  const sources = new Map(files.map((file) => [file.path, file.source]))
  const stale = new Set(memory?.planSync([...sources.values()]).map((file) => file.path))
  const subagents = subagentTranscripts(files.map((file) => file.source))
  index.buildFull((file, session, elapsedMs) => {
    summary.parsed++
    summary.toolIndexFiles++
    const source = sources.get(file.path)
    if (!memory || !source || !stale.has(file.path)) return
    try {
      syncIntoMemory(memory, source, session, subagents(file.sessionId), summary, { elapsedMs })
    } catch {
      summary.failed++
    }
  })
  summary.files = index.indexedFiles().size
  summary.durationMs = Date.now() - started
  return summary
}
