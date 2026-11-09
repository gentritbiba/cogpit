/**
 * Byte budget for the line-based `?tail=` payload. `tail=30` reads a ~2MB
 * byte window, and a single giant tool-result line can push the response past
 * a megabyte — fine on localhost, multi-second over a tunnel. The budget caps
 * what ships on first paint; older turns arrive via `?before=` paging.
 */
export const DEFAULT_TAIL_BYTE_BUDGET = 256 * 1024
/** Byte budget for turn pages and `?before=` pages, counted on the bytes sent. */
export const DEFAULT_PAGE_BYTE_BUDGET = 512 * 1024
const MIN_BYTE_BUDGET = 16 * 1024
const MAX_BYTE_BUDGET = 16 * 1024 * 1024

/** Clamp a `?maxBytes=` override, falling back to `fallback`. */
export function parseByteBudget(raw: string | null, fallback: number): number {
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(MIN_BYTE_BUDGET, Math.min(parsed, MAX_BYTE_BUDGET))
}

/** A line's bytes on the wire as JSONL: its UTF-8 length plus the newline. */
export const lineBytes = (line: string): number => Buffer.byteLength(line, "utf8") + 1

/**
 * Index of the oldest of `lines` a page keeps when it keeps the newest lines
 * that fit `budget` bytes as `sizeOf` counts them. Always keeps the newest
 * line even when it alone exceeds the budget, and never keeps fewer than
 * `minLines` — the floor wins over the budget so one fat line cannot reduce a
 * page to a dribble. Lines `isNoise` names count toward neither. Returns
 * `lines.length` when there is nothing to keep.
 */
export function oldestKeptLine(
  lines: readonly string[],
  budget: number,
  minLines = 1,
  isNoise: (line: string) => boolean = () => false,
  sizeOf: (line: string, index: number) => number = lineBytes,
): number {
  const floor = Math.max(1, minLines)
  let oldest = lines.length
  let kept = 0
  let keptBytes = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isNoise(lines[i])) continue
    const bytes = sizeOf(lines[i], i)
    if (keptBytes + bytes > budget && kept >= floor) break
    oldest = i
    keptBytes += bytes
    kept++
  }
  return oldest
}
