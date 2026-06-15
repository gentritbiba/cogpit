/**
 * Process-local TTL cache for session metadata.
 *
 * Keyed by filePath. A cache hit requires:
 *   1. The entry exists.
 *   2. The stored `mtimeMs` matches the caller's `mtimeMs` (auto-invalidates on file change).
 *   3. The entry is younger than SESSION_META_TTL_MS.
 *
 * The mtime comparison is the real correctness mechanism — any write to the
 * session file changes mtime and misses the cache. The TTL is only a backstop
 * against pathological mtime reuse, so it can be long. (It used to be 8 s,
 * which guaranteed a cold pass on every 10 s dashboard poll: ~50 session
 * files re-read and re-scanned per poll for nothing.)
 */

import type { SessionStatusInfo } from "../../src/lib/sessionStatus"

export type SessionMeta = Awaited<ReturnType<typeof import("../sessionMetadata").getSessionMeta>>

export interface CachedMeta {
  meta: SessionMeta
  status: SessionStatusInfo
  mtimeMs: number
  cachedAt: number
}

export const SESSION_META_TTL_MS = 600_000

/** Memory backstop: evict the oldest entries once the cache grows past this. */
const MAX_ENTRIES = 1000

const cache = new Map<string, CachedMeta>()

/**
 * Return cached metadata for `filePath` if the entry exists, is not expired,
 * and matches `mtimeMs`. Returns `null` on any miss.
 */
export function getCachedSessionMeta(filePath: string, mtimeMs: number): CachedMeta | null {
  const entry = cache.get(filePath)
  if (!entry) return null
  if (entry.mtimeMs !== mtimeMs) return null
  if (Date.now() - entry.cachedAt > SESSION_META_TTL_MS) {
    cache.delete(filePath)
    return null
  }
  return entry
}

/** Store (or overwrite) a metadata entry for `filePath`. */
export function setCachedSessionMeta(filePath: string, value: CachedMeta): void {
  cache.set(filePath, value)
  if (cache.size > MAX_ENTRIES) {
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [key, entry] of cache) {
      if (entry.cachedAt < oldestAt) {
        oldestAt = entry.cachedAt
        oldestKey = key
      }
    }
    if (oldestKey !== null) cache.delete(oldestKey)
  }
}

/** Remove a single entry. Safe to call even when the path is not cached. */
export function invalidateSessionMeta(filePath: string): void {
  cache.delete(filePath)
}

/** Clear the entire cache (e.g. for tests). */
export function invalidateAll(): void {
  cache.clear()
}
