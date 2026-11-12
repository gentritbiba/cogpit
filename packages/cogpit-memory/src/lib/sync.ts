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
  /** Stale transcripts left for a later run because the time budget ran out. */
  pending: number
  durationMs: number
}

export interface SyncOptions {
  index: SearchIndex | null
  memory: MemoryStore | null
  /** Stop starting new files after this long; no limit when absent. */
  budgetMs?: number
  /** Called after each parsed file. */
  onProgress?: (summary: SyncSummary) => void
}

type ListedFile = SessionFile & { source: SourceFile }

export function emptySyncSummary(): SyncSummary {
  return { files: 0, parsed: 0, toolIndexFiles: 0, memoryFiles: 0, chunks: { added: 0, updated: 0, removed: 0 }, failed: 0, pending: 0, durationMs: 0 }
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
): void {
  const result = memory.syncSession(source, session, { hasSubagentTranscript })
  summary.memoryFiles++
  summary.chunks.added += result.added
  summary.chunks.updated += result.updated
  summary.chunks.removed += result.removed
}

export function listTranscripts(): ListedFile[] {
  return allStores().flatMap((store) => store.list(0).map((file) => ({ ...file, source: sourceFileOf(store, file) })))
}

export function syncTranscripts(options: SyncOptions): SyncSummary {
  const started = Date.now()
  const summary = emptySyncSummary()
  const files = listTranscripts()
  summary.files = files.length
  const subagents = subagentTranscripts(files.map((file) => file.source))
  const indexed = options.index?.indexedFiles()
  const stale = new Set(options.memory?.planSync(files.map((file) => file.source)).map((file) => file.path))
  const needsIndex = (file: ListedFile) => !!indexed && !((indexed.get(file.path) ?? -Infinity) >= file.mtimeMs)

  const work = files
    .filter((file) => needsIndex(file) || stale.has(file.path))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const [position, file] of work.entries()) {
    if (options.budgetMs !== undefined && Date.now() - started > options.budgetMs) {
      summary.pending = work.length - position
      break
    }
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
      if (options.memory && stale.has(file.path)) syncIntoMemory(options.memory, file.source, session, subagents(file.sessionId), summary)
    } catch {
      summary.failed++
    }
    options.onProgress?.(summary)
  }
  summary.durationMs = Date.now() - started
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
  index.buildFull((file, session) => {
    summary.parsed++
    summary.toolIndexFiles++
    const source = sources.get(file.path)
    if (!memory || !source || !stale.has(file.path)) return
    try {
      syncIntoMemory(memory, source, session, subagents(file.sessionId), summary)
    } catch {
      summary.failed++
    }
  })
  summary.files = index.indexedFiles().size
  summary.durationMs = Date.now() - started
  return summary
}
