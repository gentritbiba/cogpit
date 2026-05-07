/**
 * Process-local TTL cache for session metadata.
 *
 * Keyed by filePath. A cache hit requires:
 *   1. The entry exists.
 *   2. The stored `mtimeMs` matches the caller's `mtimeMs` (auto-invalidates on file change).
 *   3. The entry is younger than SESSION_META_TTL_MS.
 *
 * TTL: 8 seconds — request bursts arrive at 1-2 Hz, so 8 s safely covers
 * a few rapid refreshes without masking genuine session changes.
 */

import type { SessionStatusInfo } from "../../src/lib/sessionStatus"

export type SessionMeta = Awaited<ReturnType<typeof import("../sessionMetadata").getSessionMeta>>

export interface CachedMeta {
  meta: SessionMeta
  status: SessionStatusInfo
  mtimeMs: number
  cachedAt: number
}

const SESSION_META_TTL_MS = 8_000

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
}

/** Remove a single entry. Safe to call even when the path is not cached. */
export function invalidateSessionMeta(filePath: string): void {
  cache.delete(filePath)
}

/** Clear the entire cache (e.g. for tests). */
export function invalidateAll(): void {
  cache.clear()
}
