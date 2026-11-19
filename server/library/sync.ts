/**
 * Brings the library up to date with the memory store, which already holds
 * every session's reply text for every agent and account. Each transcript the
 * memory store synced since the library last read it is read again, as far as
 * its reply blocks could share anything; a sub-agent's own text never counts.
 */
import { ASSET_HINTS, extractAssets } from "../../shared/library/extract"
import type { MemoryStore } from "../../shared/memory/store"
import { projectOfCwd } from "../../shared/worktreePath"
import type { LibraryStore, Occurrence, SessionRow } from "./store"

/** Transcripts read per query, so one pass never holds the event loop for long. */
const FILES_PER_BATCH = 25

interface SourceRow {
  id: number
  path: string
  session_id: string
  synced_at: number
}

interface ChunkRow {
  file_id: number
  turn: number
  block: number
  turn_id: string | null
  timestamp: string | null
  ts_ms: number | null
  cwd: string
  text: string
}

const HINT_SQL = ASSET_HINTS.map(() => "instr(m.text, ?) > 0").join(" OR ")

export interface SyncOptions {
  pause?: () => Promise<void>
  signal?: AbortSignal
}

/** Reads what changed since the last sync; answers how many transcripts it read. */
export async function syncLibrary(memory: MemoryStore, library: LibraryStore, options: SyncOptions = {}): Promise<number> {
  const known = library.sourceStates()
  const stale = (memory.db.prepare("SELECT id, path, session_id, synced_at FROM source_files WHERE is_subagent = 0").all() as SourceRow[])
    .filter((file) => known.get(file.path) !== file.synced_at)
  for (let start = 0; start < stale.length; start += FILES_PER_BATCH) {
    if (options.signal?.aborted) return start
    const batch = stale.slice(start, start + FILES_PER_BATCH)
    library.record(
      batch.map((file) => ({ path: file.path, syncedAt: file.synced_at })),
      occurrencesIn(memory, batch),
      sessionsOf(memory, batch),
    )
    await options.pause?.()
  }
  return stale.length
}

function occurrencesIn(memory: MemoryStore, files: readonly SourceRow[]): Occurrence[] {
  const byId = new Map(files.map((file) => [file.id, file]))
  const rows = memory.db.prepare(`
    SELECT c.file_id, c.turn, c.block, c.turn_id, c.timestamp, c.ts_ms, c.cwd, c.text FROM chunks c
    WHERE c.file_id IN (${files.map(() => "?").join(", ")}) AND c.kind = 'assistant' AND c.inline_agent_id IS NULL
      AND EXISTS (SELECT 1 FROM chunks m WHERE m.file_id = c.file_id AND m.turn = c.turn AND m.block = c.block AND m.kind = 'assistant' AND (${HINT_SQL}))
    ORDER BY c.file_id, c.turn, c.block, c.part`).all(...files.map((file) => file.id), ...ASSET_HINTS) as ChunkRow[]

  const occurrences: Occurrence[] = []
  let block: ChunkRow[] = []
  const flush = () => {
    const [first] = block
    if (!first) return
    const file = byId.get(first.file_id)!
    // A long block is stored in pieces cut at line breaks; joined, a code fence spans them again.
    for (const asset of extractAssets(block.map((row) => row.text).join("\n"))) {
      occurrences.push({
        sessionId: file.session_id,
        sourceFile: file.path,
        cwd: first.cwd,
        project: projectOfCwd(first.cwd),
        kind: asset.kind,
        target: asset.target,
        label: asset.label,
        turn: first.turn,
        turnId: first.turn_id,
        sharedAt: first.timestamp,
        sharedMs: first.ts_ms,
      })
    }
    block = []
  }
  for (const row of rows) {
    const [first] = block
    if (first && (first.file_id !== row.file_id || first.turn !== row.turn || first.block !== row.block)) flush()
    block.push(row)
  }
  flush()
  return occurrences
}

function sessionsOf(memory: MemoryStore, files: readonly SourceRow[]): SessionRow[] {
  const ids = [...new Set(files.map((file) => file.session_id))]
  return memory.db.prepare(`SELECT session_id, title, cwd FROM sessions WHERE session_id IN (${ids.map(() => "?").join(", ")})`).all(...ids) as SessionRow[]
}
