/** Deep equality for JSON-shaped values (what list endpoints return). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameJson(item, b[index]))
  }
  if (Array.isArray(b)) return false
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const keys = Object.keys(aRecord)
  if (keys.length !== Object.keys(bRecord).length) return false
  return keys.every((key) => Object.hasOwn(bRecord, key) && sameJson(aRecord[key], bRecord[key]))
}

/**
 * A freshly fetched list that keeps the previous object for every unchanged
 * item, and is the previous array itself when nothing changed, so memoized
 * consumers skip the items (or the whole list) that did not move.
 */
export function shareList<T>(previous: readonly T[], next: readonly T[], keyOf: (item: T) => string): T[] {
  const previousByKey = new Map(previous.map((item) => [keyOf(item), item]))
  let unchanged = previous.length === next.length
  const shared = next.map((item, index) => {
    const old = previousByKey.get(keyOf(item))
    const kept = old !== undefined && sameJson(old, item) ? old : item
    if (kept !== previous[index]) unchanged = false
    return kept
  })
  return unchanged ? previous as T[] : shared
}
