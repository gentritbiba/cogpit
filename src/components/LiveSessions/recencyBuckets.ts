/**
 * The date shelf a session sits on in a newest-first list: a coarse label
 * that changes rarely enough to divide the run of cards without turning it
 * back into a tree.
 */
export type RecencyBucket = "Today" | "Yesterday" | "Last 7 days" | "Last 30 days" | "Older"

const DAY_MS = 86_400_000

function startOfLocalDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Sorted by the same rule as `sortSessionsByRecency`, so an unparsable time shelves last too. */
export function recencyBucket(iso: string, now = Date.now()): RecencyBucket {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return "Older"
  const today = startOfLocalDay(now)
  if (then >= today) return "Today"
  if (then >= today - DAY_MS) return "Yesterday"
  if (then >= today - 6 * DAY_MS) return "Last 7 days"
  if (then >= today - 29 * DAY_MS) return "Last 30 days"
  return "Older"
}
