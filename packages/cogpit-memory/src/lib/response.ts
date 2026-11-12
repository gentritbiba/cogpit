/** Parse a duration like "5d", "12h" or "30m" to milliseconds; null when it is not one. */
export function parseMaxAge(raw: string): number | null {
  const match = raw.match(/^(\d+)([dhm])$/)
  if (!match) return null
  const unit = { d: 24 * 60 * 60 * 1000, h: 60 * 60 * 1000, m: 60 * 1000 }[match[2] as "d" | "h" | "m"]
  return parseInt(match[1], 10) * unit
}

export const MAX_AGE_HELP = "use a number followed by d, h or m, such as 7d"
