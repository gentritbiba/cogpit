/**
 * Index commands.
 *
 *   indexStats(dbPath?)   — tool index stats plus memory store counts
 *   indexRebuild(dbPath?) — rebuilds the FTS5 tool index; the memory store is never rebuilt
 *   indexSync(options?)   — brings both stores up to date, with no time budget
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { SearchIndex, type IndexStats } from "../lib/search-index"
import { DEFAULT_DB_PATH } from "../lib/dirs"
import { memoryDir, openMemoryStore, transcriptExists } from "../lib/memory-store"
import type { MemoryStatus } from "../lib/memory/store"
import { rebuildToolIndex, syncTranscripts, type SyncSummary } from "../lib/sync"

/** The memory store's counts, or why it cannot be used. */
export type MemoryStats = (MemoryStatus & { dir: string }) | { dir: string; error: string }

export async function indexStats(dbPath?: string): Promise<(IndexStats & { memory: MemoryStats }) | { error: string }> {
  const path = dbPath ?? DEFAULT_DB_PATH
  if (!existsSync(path)) {
    return { error: `Database not found at ${path}. Run 'cogpit-memory index rebuild' to create it.` }
  }
  const index = new SearchIndex(path)
  const stats = index.getStats()
  index.close()
  return { ...stats, memory: memoryStats() }
}

export async function indexRebuild(dbPath?: string): Promise<{ status: string; stats: IndexStats }> {
  const path = dbPath ?? DEFAULT_DB_PATH
  mkdirSync(dirname(path), { recursive: true })
  const index = new SearchIndex(path)
  index.buildFull()
  const stats = index.getStats()
  index.close()
  return { status: "rebuilt", stats }
}

export interface IndexSyncResult {
  status: "synced"
  sync: SyncSummary
  memory: MemoryStats
}

/** Bring the tool index and the memory store up to date from one parse per changed transcript. */
export async function indexSync(options: { dbPath?: string; onProgress?: (summary: SyncSummary) => void } = {}): Promise<IndexSyncResult | { error: string }> {
  const path = options.dbPath ?? DEFAULT_DB_PATH
  const indexWasMissing = !existsSync(path)
  mkdirSync(dirname(path), { recursive: true })
  let memory
  try {
    memory = openMemoryStore()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const index = new SearchIndex(path)
  try {
    const sync = indexWasMissing
      ? rebuildToolIndex(index, memory)
      : syncTranscripts({ index, memory, onProgress: options.onProgress })
    return { status: "synced", sync, memory: { dir: memoryDir(), ...memory.status({ fileExists: transcriptExists }) } }
  } finally {
    index.close()
    memory.close()
  }
}

function memoryStats(): MemoryStats {
  const dir = memoryDir()
  try {
    const store = openMemoryStore(dir)
    try {
      return { dir, ...store.status({ fileExists: transcriptExists }) }
    } finally {
      store.close()
    }
  } catch (error) {
    return { dir, error: error instanceof Error ? error.message : String(error) }
  }
}
