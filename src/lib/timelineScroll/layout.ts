/**
 * Row geometry for the timeline. Positions are content coordinates: offsets
 * inside the scroller's scrollable content, which scrolling never changes.
 */

/** A half-open run of row indices. */
export interface Extent {
  start: number
  end: number
}

/** A range addressed by the keys of its first and last item, so inserting items elsewhere does not move it. */
export interface KeyRange {
  first: string
  last: string
}

export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function toKeyRange(keys: readonly string[], range: Extent): KeyRange | null {
  return range.end > range.start ? { first: keys[range.start], last: keys[range.end - 1] } : null
}

/** Where a key range sits now; null once either end is gone. */
export function toExtent(indexOf: ReadonlyMap<string, number>, range: KeyRange | null): Extent | null {
  if (!range) return null
  const start = indexOf.get(range.first)
  const last = indexOf.get(range.last)
  return start === undefined || last === undefined || last < start ? null : { start, end: last + 1 }
}

export function sumHeights(heights: ArrayLike<number>, start: number, end: number): number {
  let total = 0
  for (let i = start; i < end; i++) total += heights[i]
  return total
}

/**
 * Tops of every row. Rows with a measured top keep it; the rest are stacked
 * from their nearest neighbour above, or below for rows before the first
 * measured one.
 */
export function layoutTops(heights: ArrayLike<number>, known: ReadonlyMap<number, number>): Float64Array {
  const n = heights.length
  const tops = new Float64Array(n)
  let first = n
  for (const index of known.keys()) if (index >= 0 && index < n && index < first) first = index
  if (first === n) first = 0
  tops[first] = known.get(first) ?? 0
  for (let i = first - 1; i >= 0; i--) tops[i] = tops[i + 1] - heights[i]
  for (let i = first + 1; i < n; i++) tops[i] = known.get(i) ?? tops[i - 1] + heights[i - 1]
  return tops
}

/** First row whose bottom lies below `y`. */
function firstEndingBelow(tops: ArrayLike<number>, heights: ArrayLike<number>, y: number): number {
  let lo = 0
  let hi = tops.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (tops[mid] + heights[mid] <= y) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Rows intersecting `[from, to)`, clamped so a band beyond the rows still yields the nearest one. */
export function rowsOverlapping(tops: ArrayLike<number>, heights: ArrayLike<number>, from: number, to: number): Extent {
  const n = tops.length
  if (n === 0) return { start: 0, end: 0 }
  const start = Math.min(firstEndingBelow(tops, heights, from), n - 1)
  let end = start + 1
  while (end < n && tops[end] < to) end++
  return { start, end }
}

/** Overscan rendered beyond each edge of the viewport, in viewports. */
const OVERSCAN = 1
/** The committed range is kept while it covers this much beyond each edge. */
export const INNER_BAND = 0.5
/** ...and while it reaches no further than this. */
export const OUTER_BAND = 2

interface PlanInput {
  tops: ArrayLike<number>
  heights: ArrayLike<number>
  /** The committed range, or null before the first plan. */
  current: Extent | null
  viewTop: number
  viewport: number
  follow: boolean
}

function covers(tops: ArrayLike<number>, heights: ArrayLike<number>, range: Extent, from: number, to: number): boolean {
  const n = tops.length
  if (range.end <= range.start) return n === 0
  const top = range.start === 0 ? -Infinity : tops[range.start]
  const bottom = range.end >= n ? Infinity : tops[range.end - 1] + heights[range.end - 1]
  return top <= from && bottom >= to
}

function reachesPast(tops: ArrayLike<number>, heights: ArrayLike<number>, range: Extent, from: number, to: number): boolean {
  if (range.end <= range.start) return false
  return tops[range.start] + heights[range.start] < from || tops[range.end - 1] > to
}

/**
 * The rows to render. A committed range is kept until scrolling leaves its
 * inner band or it grows beyond its outer band, so React re-renders the list
 * only every half viewport of travel, not on every scroll event.
 */
export function planRange({ tops, heights, current, viewTop, viewport, follow }: PlanInput): Extent {
  const n = tops.length
  const viewBottom = viewTop + viewport
  const keep = current
    && current.end <= n
    && (!follow || current.end === n)
    && covers(tops, heights, current, viewTop - viewport * INNER_BAND, viewBottom + viewport * INNER_BAND)
    && !reachesPast(tops, heights, current, viewTop - viewport * OUTER_BAND, viewBottom + viewport * OUTER_BAND)
  if (keep) return current
  const range = rowsOverlapping(tops, heights, viewTop - viewport * OVERSCAN, viewBottom + viewport * OVERSCAN)
  return follow ? { start: Math.min(range.start, Math.max(0, n - 1)), end: n } : range
}

/** The committed range plus rows that must stay mounted outside it, as sorted disjoint runs. */
export function mergeSegments(range: Extent, pinned: Iterable<number>, count = Infinity): Extent[] {
  const runs: Extent[] = range.end > range.start ? [{ ...range }] : []
  for (const index of pinned) {
    if (index < 0 || index >= count) continue
    runs.push({ start: index, end: index + 1 })
  }
  runs.sort((a, b) => a.start - b.start)
  const merged: Extent[] = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (last && run.start <= last.end) last.end = Math.max(last.end, run.end)
    else merged.push({ ...run })
  }
  return merged
}
