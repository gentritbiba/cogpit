// SHARED MEMORY CORE: edit shared/memory only; cogpit-memory copies are generated.
/**
 * Reciprocal rank fusion: each list contributes 1 / (k + rank) for every item
 * it ranks, so lists with incomparable scores (BM25, cosine, recency) combine
 * without calibration. Equal weights, k = 60.
 */
export const RRF_K = 60

export function rrfScore(ranks: Iterable<number | undefined>, k = RRF_K): number {
  let score = 0
  for (const rank of ranks) if (rank !== undefined) score += 1 / (k + rank)
  return score
}

/**
 * Keep the best-ranked item of each group of identical text and count the
 * rest, so a forked session does not fill the results with copies.
 */
export function collapseDuplicates<T extends { duplicates: number }>(ranked: readonly T[], textKey: (item: T) => string): T[] {
  const kept = new Map<string, T>()
  for (const item of ranked) {
    const key = textKey(item)
    const first = kept.get(key)
    if (first) first.duplicates++
    else kept.set(key, item)
  }
  return [...kept.values()]
}
