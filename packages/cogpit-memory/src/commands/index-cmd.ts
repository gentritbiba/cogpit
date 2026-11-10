/**
 * Index commands.
 *
 *   indexStats(dbPath?)   — tool index stats plus memory store counts
 *   indexRebuild(dbPath?) — rebuilds the FTS5 tool index; the memory store is never rebuilt
 *   indexSync(options?)   — brings both stores up to date with no time budget, then embeds pending chunks
 *   indexConfig(changes)  — shows or changes the embedding endpoint in config.json
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { SearchIndex, type IndexStats } from "../lib/search-index"
import { DEFAULT_DB_PATH } from "../lib/dirs"
import { memoryDir, openMemoryStore, transcriptExists } from "../lib/memory-store"
import type { MemoryStatus } from "../lib/memory/store"
import { rebuildToolIndex, syncTranscripts, type SyncSummary } from "../lib/sync"
import { describeConfig, loadEmbeddings, memoryConfigPath, writeEmbeddingConfig, type LoadedEmbeddings } from "../lib/embedding-config"
import type { EmbeddingConfig } from "../lib/memory/embeddings"
import { embedPending, type EmbedPendingResult } from "../lib/memory/vectors"

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

/** Embeddings as configured: off with a reason, or the endpoint in use (API key masked). */
export type EmbeddingsInfo = { state: "off"; reason: string } | { state: "configured"; config: ReturnType<typeof describeConfig> }

export interface IndexSyncResult {
  status: "synced"
  sync: SyncSummary
  embeddings: EmbedPendingResult | { state: "off"; reason: string }
  memory: MemoryStats
}

export interface SyncProgress {
  sync?(summary: SyncSummary): void
  embed?(embedded: number, remaining: number): void
}

/**
 * Bring the tool index and the memory store up to date from one parse per
 * changed transcript, then embed every pending chunk when an endpoint is set.
 */
export async function indexSync(options: { dbPath?: string; progress?: SyncProgress } = {}): Promise<IndexSyncResult | { error: string }> {
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
      : syncTranscripts({ index, memory, onProgress: options.progress?.sync })
    const { client, reason, error } = loadEmbeddings()
    const embeddings = client
      ? await embedPending(memory, client, { onBatch: options.progress?.embed })
      : { state: "off" as const, reason: error ?? reason ?? "" }
    return { status: "synced", sync, embeddings, memory: { dir: memoryDir(), ...memory.status({ fileExists: transcriptExists, fingerprint: client?.fingerprint }) } }
  } finally {
    index.close()
    memory.close()
  }
}

/** Show the embedding configuration, or change it when `changes` or `off` are given. */
export async function indexConfig(changes: Partial<EmbeddingConfig>, off = false): Promise<object> {
  if (off || Object.keys(changes).length > 0) return writeEmbeddingConfig(changes, { off })
  return { path: memoryConfigPath(), embeddings: embeddingsInfo(loadEmbeddings()) }
}

function embeddingsInfo(loaded: LoadedEmbeddings): EmbeddingsInfo {
  return loaded.client
    ? { state: "configured", config: describeConfig(loaded.client.config) }
    : { state: "off", reason: loaded.error ?? loaded.reason ?? "" }
}

function memoryStats(): MemoryStats & { embeddingConfig?: EmbeddingsInfo } {
  const dir = memoryDir()
  const loaded = loadEmbeddings(dir)
  try {
    const store = openMemoryStore(dir)
    try {
      return { dir, ...store.status({ fileExists: transcriptExists, fingerprint: loaded.client?.fingerprint }), embeddingConfig: embeddingsInfo(loaded) }
    } finally {
      store.close()
    }
  } catch (error) {
    return { dir, error: error instanceof Error ? error.message : String(error) }
  }
}
