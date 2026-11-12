// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
/**
 * Stored vectors: embedding what is pending, and brute-force cosine scoring
 * in process. The endpoint is called outside any transaction; every write is
 * an idempotent upsert, so two processes embedding the same text only waste
 * a request.
 */
import { withTx } from "./database"
import { cosine, EmbeddingError, type EmbeddingClient, type QuantizedVector } from "./embeddings"
import { filterSql, type ChunkFilters } from "./keywordSearch"
import { embeddingCounts, MISSING_VECTOR, type MemoryStore } from "./store"

export interface EmbedPendingOptions {
  /** Texts per request. Default 32. */
  batchSize?: number
  /** Stop starting new batches after this long. */
  budgetMs?: number
  signal?: AbortSignal
  /** Awaited between batches, so a server can yield. */
  pause?(): Promise<void>
  onBatch?(embedded: number, remaining: number): void
}

export interface EmbedPendingResult {
  fingerprint: string
  /** Distinct texts sent to the endpoint and stored. */
  embedded: number
  /** Chunks that got a vector without a request of their own, sharing another chunk's text. */
  reused: number
  /** Texts the endpoint refused; they stay pending. */
  failed: number
  /** Chunks still without a vector for this fingerprint. */
  remaining: number
  durationMs: number
  /** Why the run stopped early, e.g. the endpoint is down. */
  error?: string
}

const DEFAULT_BATCH_SIZE = 32

function storeVectors(store: MemoryStore, fingerprint: string, hashes: readonly string[], vectors: readonly QuantizedVector[]): void {
  const insert = store.db.prepare("INSERT OR REPLACE INTO vectors (text_hash, fingerprint, vector, norm) VALUES (?, ?, ?, ?)")
  withTx(store.db, () => {
    hashes.forEach((hash, i) => {
      const { values, norm } = vectors[i]!
      insert.run(hash, fingerprint, new Uint8Array(values.buffer, values.byteOffset, values.byteLength), norm)
    })
  })
}

/** Embed every chunk text without a vector for the client's fingerprint, oldest hash order, resumable at any point. */
export async function embedPending(store: MemoryStore, client: EmbeddingClient, options: EmbedPendingOptions = {}): Promise<EmbedPendingResult> {
  const started = Date.now()
  const { fingerprint } = client
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
  const result: EmbedPendingResult = { fingerprint, embedded: 0, reused: 0, failed: 0, remaining: 0, durationMs: 0 }
  withTx(store.db, () => store.db.exec("DELETE FROM vectors WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.text_hash = vectors.text_hash)"))
  const before = embeddingCounts(store, fingerprint)
  const next = store.db.prepare(`SELECT c.text_hash AS hash, MIN(c.text) AS text FROM chunks c
    WHERE c.text_hash > ? AND ${MISSING_VECTOR} GROUP BY c.text_hash ORDER BY c.text_hash LIMIT ?`)
  let cursor = ""

  // Only a refusal of particular texts is worth stepping past; anything else (the endpoint is down, the run was cancelled) ends the run.
  const refused = (error: unknown) => error instanceof EmbeddingError && !error.retryable && !options.signal?.aborted
  run: for (;;) {
    if (options.signal?.aborted || (options.budgetMs !== undefined && Date.now() - started > options.budgetMs)) break
    const batch = next.all(cursor, fingerprint, batchSize) as Array<{ hash: string; text: string }>
    if (batch.length === 0) break
    cursor = batch.at(-1)!.hash
    try {
      storeVectors(store, fingerprint, batch.map((row) => row.hash), await client.embedDocuments(batch.map((row) => row.text), options.signal))
      result.embedded += batch.length
    } catch (error) {
      if (!refused(error)) {
        result.error = error instanceof Error ? error.message : String(error)
        break
      }
      // Find the texts it refuses and keep the rest.
      for (const row of batch) {
        try {
          storeVectors(store, fingerprint, [row.hash], await client.embedDocuments([row.text], options.signal))
          result.embedded++
        } catch (itemError) {
          if (!refused(itemError)) {
            result.error = itemError instanceof Error ? itemError.message : String(itemError)
            break run
          }
          result.failed++
        }
      }
    }
    options.onBatch?.(result.embedded, before.pending - result.embedded)
    await options.pause?.()
  }

  const after = embeddingCounts(store, fingerprint)
  result.remaining = after.pending
  result.reused = Math.max(0, after.embedded - before.embedded - result.embedded)
  // Once current, vectors of an earlier model or size only take space.
  if (after.pending === 0) withTx(store.db, () => store.db.prepare("DELETE FROM vectors WHERE fingerprint != ?").run(fingerprint))
  result.durationMs = Date.now() - started
  return result
}

export interface VectorMatch {
  chunkId: number
  similarity: number
}

/** The `limit` chunks most similar to `query` at or above `minScore`, best first, and the ids of every chunk that reached it. */
export function vectorSearch(
  store: MemoryStore,
  query: QuantizedVector,
  fingerprint: string,
  filters: ChunkFilters,
  limit: number,
  minScore: number,
): { matches: VectorMatch[]; aboveFloor: number[] } {
  const where = filterSql(filters)
  const rows = store.db.prepare(`SELECT c.id AS id, v.vector AS vector, v.norm AS norm FROM chunks c
    JOIN vectors v ON v.text_hash = c.text_hash AND v.fingerprint = ?
    WHERE 1 = 1${where.sql}`).all(fingerprint, ...where.params) as Array<{ id: number; vector: Uint8Array; norm: number }>
  const matches: VectorMatch[] = []
  for (const row of rows) {
    const similarity = cosine(query, new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), row.norm)
    if (similarity >= minScore) matches.push({ chunkId: row.id, similarity })
  }
  const aboveFloor = matches.map((match) => match.chunkId)
  return { matches: matches.sort((a, b) => b.similarity - a.similarity).slice(0, limit), aboveFloor }
}
