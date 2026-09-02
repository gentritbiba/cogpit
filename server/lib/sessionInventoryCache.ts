export function createSessionInventoryCache<T>(
  load: () => Promise<T[]>,
  ttlMs = 1000,
): { get: () => Promise<T[]>; invalidate: () => void } {
  let cached: { loadedAt: number; entries: T[] } | null = null
  let inFlight: Promise<T[]> | null = null

  return {
    get() {
      if (cached && Date.now() - cached.loadedAt <= ttlMs) {
        return Promise.resolve(cached.entries)
      }
      if (inFlight) return inFlight
      inFlight = load()
        .then((entries) => {
          cached = { loadedAt: Date.now(), entries }
          return entries
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
    invalidate() {
      cached = null
      inFlight = null
    },
  }
}
