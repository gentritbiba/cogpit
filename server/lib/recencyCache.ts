export interface RecencyCacheLimits {
  /** Entries kept however long unused; past it the least recently used goes first. */
  capacity: number
  /**
   * Past `capacity`, an entry used this recently stays too, so the sessions
   * every user's polls still read stay cached however many users there are.
   */
  inUseMs: number
  /** The most entries kept however recently used: the memory backstop. */
  ceiling: number
}

export interface RecencyCache<V> {
  /** The value stored for `key`, which now counts as just used. */
  get(key: string): V | undefined
  /** Store `value` as the most recently used, dropping what the limits allow. */
  set(key: string, value: V): void
  delete(key: string): void
  clear(): void
}

/** A bounded map of per-session state that any number of users' polls share. */
export function recencyCache<V>({ capacity, inUseMs, ceiling }: RecencyCacheLimits): RecencyCache<V> {
  // Insertion order is recency order: every use moves an entry to the end.
  const entries = new Map<string, { value: V; usedAt: number }>()

  function use(key: string, value: V): void {
    entries.delete(key)
    entries.set(key, { value, usedAt: Date.now() })
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (entry) use(key, entry.value)
      return entry?.value
    },
    set(key, value) {
      use(key, value)
      const now = Date.now()
      for (const [oldest, { usedAt }] of entries) {
        if (entries.size <= capacity) return
        if (entries.size <= ceiling && now - usedAt < inUseMs) return
        entries.delete(oldest)
      }
    },
    delete(key) {
      entries.delete(key)
    },
    clear() {
      entries.clear()
    },
  }
}
