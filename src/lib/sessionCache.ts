import type { ParsedSession } from "@/lib/types"

export interface CacheEntry {
  parsed: ParsedSession
  source: {
    dirName: string
    fileName: string
    rawText: string
    agentKind?: "claude" | "codex"
  }
  nextByteOffset: number
  hasMore: boolean
  lastAccessed: number
}

const MAX_ENTRIES = 5

function makeKey(dirName: string, fileName: string): string {
  return `${dirName}/${fileName}`
}

class SessionCache {
  private cache = new Map<string, CacheEntry>()

  get(dirName: string, fileName: string): CacheEntry | undefined {
    const key = makeKey(dirName, fileName)
    const entry = this.cache.get(key)
    if (entry) {
      entry.lastAccessed = Date.now()
    }
    return entry
  }

  set(
    dirName: string,
    fileName: string,
    parsed: ParsedSession,
    rawText: string,
    nextByteOffset: number,
    hasMore: boolean,
    agentKind?: "claude" | "codex",
  ): void {
    const key = makeKey(dirName, fileName)

    if (!this.cache.has(key) && this.cache.size >= MAX_ENTRIES) {
      this.evictLRU()
    }

    this.cache.set(key, {
      parsed,
      source: { dirName, fileName, rawText, agentKind },
      nextByteOffset,
      hasMore,
      lastAccessed: Date.now(),
    })
  }

  update(dirName: string, fileName: string, partial: Partial<Omit<CacheEntry, "source">> & { source?: Partial<CacheEntry["source"]> }): void {
    const key = makeKey(dirName, fileName)
    const entry = this.cache.get(key)
    if (!entry) return

    if (partial.parsed !== undefined) entry.parsed = partial.parsed
    if (partial.nextByteOffset !== undefined) entry.nextByteOffset = partial.nextByteOffset
    if (partial.hasMore !== undefined) entry.hasMore = partial.hasMore
    if (partial.lastAccessed !== undefined) entry.lastAccessed = partial.lastAccessed
    if (partial.source) {
      entry.source = { ...entry.source, ...partial.source }
    }
  }

  updateRawText(dirName: string, fileName: string, rawText: string): void {
    const key = makeKey(dirName, fileName)
    const entry = this.cache.get(key)
    if (!entry) return
    entry.source.rawText = rawText
  }

  evict(dirName?: string, fileName?: string): void {
    if (dirName !== undefined && fileName !== undefined) {
      this.cache.delete(makeKey(dirName, fileName))
    } else {
      this.evictLRU()
    }
  }

  clear(): void {
    this.cache.clear()
  }

  private evictLRU(): void {
    let oldestKey: string | undefined
    let oldestTime = Infinity

    for (const [key, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed
        oldestKey = key
      }
    }

    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey)
    }
  }
}

export const sessionCache = new SessionCache()
