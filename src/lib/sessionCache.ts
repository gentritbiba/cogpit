import type { Turn } from "../../shared/session/types"
import type { SessionView } from "../../shared/session/sessionDigest"
import { getActiveDeviceScope, getActiveIdentity } from "@/lib/device"
import { rootSessionIdOf } from "@/lib/agents"
import type { SessionSource } from "@/lib/sessionSource"

export interface CacheEntry {
  parsed: SessionView
  /**
   * Turns paged in above the loaded window, oldest first. Stored next to
   * `nextByteOffset` so the cursor and the history it consumed can never
   * disagree — a cursor without its pages leaves an ungettable gap.
   */
  olderTurns: Turn[]
  source: SessionSource
  nextByteOffset: number
  hasMore: boolean
  lastAccessed: number
}

const MAX_ENTRIES = 5
/**
 * Transcript bytes the entries may cover together. A tail covers well under a
 * megabyte; history paged in above it is what grows, so a few sessions read far
 * back cannot keep hundreds of megabytes of turns alive after the user left.
 */
export const MAX_CACHED_TRANSCRIPT_BYTES = 64 * 1024 * 1024

/** The transcript span an entry holds turns for: from its oldest page to where the stream has read. */
function coveredBytes(entry: CacheEntry): number {
  return Math.max(0, entry.source.watchOffset - entry.nextByteOffset)
}

// Device-scoped so cross-device dirName collisions are impossible and switching
// back to a device keeps its entries warm. This module is a singleton that
// survives the DeviceRoot remount, so the prefix is the only isolation.
function activeScope(): string {
  const device = getActiveDeviceScope()
  const identity = getActiveIdentity()
  return identity === null ? device : `${device}:${identity}`
}

/** The cache key of a transcript on the active device and identity. */
export function sessionCacheKey(dirName: string, fileName: string): string {
  return `${activeScope()}:${dirName}/${fileName}`
}

type ReleaseListener = (view: SessionView) => void

class SessionCache {
  private cache = new Map<string, CacheEntry>()
  /** The view each session shell has on screen, which outlives its entry. */
  private screens = new Map<object, SessionView>()
  private releaseListeners = new Set<ReleaseListener>()

  /** Calls `listener` with every view the cache or a screen lets go of. */
  onRelease(listener: ReleaseListener): () => void {
    this.releaseListeners.add(listener)
    return () => { this.releaseListeners.delete(listener) }
  }

  /** Every view still held: each entry's, and each screen's. */
  *heldViews(): Generator<SessionView> {
    for (const entry of this.cache.values()) yield entry.parsed
    yield* this.screens.values()
  }

  /** `screen` now shows `view`, or nothing; the view it showed before is let go of. */
  show(screen: object, view: SessionView | null): void {
    const previous = this.screens.get(screen)
    if (view) this.screens.set(screen, view)
    else this.screens.delete(screen)
    if (previous && previous !== view) this.release(previous)
  }

  /** A view that was loaded but is not kept. */
  discard(view: SessionView): void {
    this.release(view)
  }

  private release(view: SessionView): void {
    for (const listener of this.releaseListeners) listener(view)
  }

  private drop(key: string): void {
    const entry = this.cache.get(key)
    if (!entry) return
    this.cache.delete(key)
    this.release(entry.parsed)
  }

  get(dirName: string, fileName: string): CacheEntry | undefined {
    const key = sessionCacheKey(dirName, fileName)
    const entry = this.cache.get(key)
    if (entry) {
      entry.lastAccessed = Date.now()
    }
    return entry
  }

  set(parsed: SessionView, source: SessionSource, nextByteOffset: number, hasMore: boolean): void {
    const key = sessionCacheKey(source.dirName, source.fileName)

    const replaced = this.cache.get(key)
    this.cache.set(key, {
      parsed,
      olderTurns: [],
      source,
      nextByteOffset,
      hasMore,
      lastAccessed: Date.now(),
    })
    if (replaced) this.release(replaced.parsed)
    this.trim(key)
  }

  update(dirName: string, fileName: string, partial: Partial<Omit<CacheEntry, "source">> & { source?: Partial<CacheEntry["source"]> }): void {
    const key = sessionCacheKey(dirName, fileName)
    const entry = this.cache.get(key)
    if (!entry) return

    const previous = entry.parsed
    if (partial.parsed !== undefined) entry.parsed = partial.parsed
    if (partial.olderTurns !== undefined) entry.olderTurns = partial.olderTurns
    if (partial.nextByteOffset !== undefined) entry.nextByteOffset = partial.nextByteOffset
    if (partial.hasMore !== undefined) entry.hasMore = partial.hasMore
    if (partial.lastAccessed !== undefined) entry.lastAccessed = partial.lastAccessed
    if (partial.source) {
      entry.source = { ...entry.source, ...partial.source }
    }
    if (entry.parsed !== previous) this.release(previous)
    this.trim(key)
  }

  evict(dirName?: string, fileName?: string): void {
    if (dirName !== undefined && fileName !== undefined) {
      this.drop(sessionCacheKey(dirName, fileName))
    } else {
      this.evictLRU()
    }
  }

  /** Drop every transcript of a session on the active device: its own, and those filed under it. */
  evictSession(sessionId: string): void {
    const prefix = `${activeScope()}:`
    for (const [key, { source }] of this.cache) {
      if (key.startsWith(prefix) && rootSessionIdOf(source.dirName, source.fileName) === sessionId) this.drop(key)
    }
  }

  clear(): void {
    for (const key of [...this.cache.keys()]) this.drop(key)
  }

  /** Drops least recently used entries, never `keep`, until the cache is within both bounds. */
  private trim(keep: string): void {
    let bytes = 0
    for (const entry of this.cache.values()) bytes += coveredBytes(entry)
    while (this.cache.size > MAX_ENTRIES || bytes > MAX_CACHED_TRANSCRIPT_BYTES) {
      const key = this.leastRecentlyUsed(keep)
      if (key === undefined) return
      bytes -= coveredBytes(this.cache.get(key)!)
      this.drop(key)
    }
  }

  private evictLRU(): void {
    const key = this.leastRecentlyUsed()
    if (key !== undefined) this.drop(key)
  }

  private leastRecentlyUsed(except?: string): string | undefined {
    let oldestKey: string | undefined
    let oldestTime = Infinity
    for (const [key, entry] of this.cache) {
      if (key !== except && entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed
        oldestKey = key
      }
    }
    return oldestKey
  }
}

export const sessionCache = new SessionCache()
