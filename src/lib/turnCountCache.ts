const STORAGE_KEY = "aw:turnCounts"
const MAX_ENTRIES = 200

// In-memory cache, hydrated from localStorage on init
const cache = new Map<string, number>()

try {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) {
    const entries: [string, number][] = JSON.parse(stored)
    for (const [k, v] of entries) cache.set(k, v)
  }
} catch { /* ignore */ }

function persist() {
  try {
    const entries = [...cache.entries()].slice(-MAX_ENTRIES)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch { /* ignore */ }
}

export function getCachedTurnCount(sessionId: string): number | null {
  return cache.get(sessionId) ?? null
}

export function cacheTurnCount(sessionId: string, count: number): void {
  cache.set(sessionId, count)
  persist()
}

/**
 * Best available turn count: max of cached (accurate, from loading session)
 * and server-provided (cheap partial read). Turns only grow, so max is safest.
 */
export function resolveTurnCount(sessionId: string, serverCount?: number): number {
  const cached = cache.get(sessionId)
  return Math.max(cached ?? 0, serverCount ?? 0)
}

/** Turn count to Tailwind text color: green (few) → red (many). */
export function turnCountColor(count: number): string {
  if (count <= 3) return "text-green-400"
  if (count <= 10) return "text-emerald-400"
  if (count <= 25) return "text-amber-400"
  if (count <= 50) return "text-orange-400"
  return "text-red-400"
}
