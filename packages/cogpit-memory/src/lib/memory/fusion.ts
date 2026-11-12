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
 * One item per group of identical text, at the group's best position, with
 * the rest counted, so a forked session does not fill the results with
 * copies. The kept item is the best-ranked one `prefer` accepts, else the
 * best-ranked one.
 */
export function collapseDuplicates<T extends { duplicates: number }>(
  ranked: readonly T[],
  textKey: (item: T) => string,
  prefer?: (item: T) => boolean,
): T[] {
  const groups = new Map<string, T[]>()
  for (const item of ranked) {
    const key = textKey(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return [...groups.values()].map((group) => {
    const kept = (prefer && group.find(prefer)) || group[0]!
    kept.duplicates += group.length - 1
    return kept
  })
}
