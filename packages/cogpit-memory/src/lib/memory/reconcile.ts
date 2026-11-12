// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
/**
 * The correctness path for keeping a store current: compare every transcript
 * the caller's walker found with what the store has, and sync the difference,
 * newest first. A change feed can only make this run sooner.
 */
import type { ParsedSession } from "../types"
import { subagentTranscripts, type MemoryStore, type SyncResult } from "./store"
import type { SourceFile } from "./types"

export interface ReconcileIo {
  /** Read and parse a transcript (`skipStats: true`); null skips it until its next change. */
  parse(file: SourceFile): Promise<ParsedSession | null> | ParsedSession | null
  /** Title to snapshot for a session's own transcript. */
  title?(file: SourceFile): string | null | undefined
  /** Awaited between files, so a server can yield to its event loop. */
  pause?(): Promise<void>
}

export interface ReconcileOptions {
  /** Stop starting new files after this long. */
  budgetMs?: number
  signal?: AbortSignal
  onFile?(file: SourceFile, result: SyncResult): void
}

export interface ReconcileSummary {
  /** Files the walker found. */
  files: number
  /** Files that were stale or new. */
  stale: number
  synced: number
  failed: number
  /** Stale files left for the next run (budget or abort). */
  pending: number
  chunks: { added: number; updated: number; removed: number }
  durationMs: number
}

export { subagentTranscripts }

export async function reconcileStore(
  store: MemoryStore,
  files: readonly SourceFile[],
  io: ReconcileIo,
  options: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const started = Date.now()
  const stale = store.planSync(files)
  const hasTranscript = subagentTranscripts(files)
  const summary: ReconcileSummary = {
    files: files.length, stale: stale.length, synced: 0, failed: 0, pending: 0, chunks: { added: 0, updated: 0, removed: 0 }, durationMs: 0,
  }
  for (const [position, file] of stale.entries()) {
    if (options.signal?.aborted || (options.budgetMs !== undefined && Date.now() - started > options.budgetMs)) {
      summary.pending = stale.length - position
      break
    }
    try {
      const parseStarted = Date.now()
      const session = await io.parse(file)
      if (session) {
        const result = store.syncSession(file, session, {
          title: io.title?.(file),
          hasSubagentTranscript: hasTranscript(file.sessionId),
          elapsedMs: Date.now() - parseStarted,
        })
        summary.synced++
        summary.chunks.added += result.added
        summary.chunks.updated += result.updated
        summary.chunks.removed += result.removed
        options.onFile?.(file, result)
      }
    } catch {
      summary.failed++
    }
    await io.pause?.()
  }
  summary.durationMs = Date.now() - started
  return summary
}
