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

import type { SessionStatusInfo } from "../../shared/session/sessionStatus"
import { recencyCache } from "./recencyCache"

export type SessionMeta = Awaited<ReturnType<typeof import("../sessionMetadata").getSessionMeta>>

export interface CachedMeta {
  meta: SessionMeta
  status: SessionStatusInfo
  mtimeMs: number
  cachedAt: number
}

export const SESSION_META_TTL_MS = 600_000

/** Every user's sidebar rows stay cached while their polls read them, up to the ceiling. */
const cache = recencyCache<CachedMeta>({ capacity: 1_000, inUseMs: 60_000, ceiling: 5_000 })
const inFlight = new Map<string, Promise<CachedMeta>>()

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

/**
 * Return cached metadata or share one loader across concurrent callers for the
 * same file revision. This avoids duplicate full-file parsing on home load.
 */
export function getOrLoadSessionMeta(
  filePath: string,
  mtimeMs: number,
  load: () => Promise<Pick<CachedMeta, "meta" | "status">>,
): Promise<CachedMeta> {
  const cached = getCachedSessionMeta(filePath, mtimeMs)
  if (cached) return Promise.resolve(cached)

  const key = `${filePath}\0${mtimeMs}`
  const pending = inFlight.get(key)
  if (pending) return pending

  const request = load()
    .then(({ meta, status }) => {
      const value = { meta, status, mtimeMs, cachedAt: Date.now() }
      setCachedSessionMeta(filePath, value)
      return value
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, request)
  return request
}
