import { useEffect, useState } from "react"

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

export function relativeTime(timestamp: string, now: number): string {
  const value = Date.parse(timestamp)
  if (!Number.isFinite(value)) return "Unknown time"
  const seconds = Math.round((value - now) / 1000)
  if (Math.abs(seconds) < 60) return RELATIVE_TIME.format(seconds, "second")
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return RELATIVE_TIME.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return RELATIVE_TIME.format(hours, "hour")
  return RELATIVE_TIME.format(Math.round(hours / 24), "day")
}

export function duration(start: string | null, end: string | null, now: number): string | null {
  const from = start ? Date.parse(start) : Number.NaN
  if (!Number.isFinite(from)) return null
  const to = end ? Date.parse(end) : now
  const total = Math.max(0, Math.round((to - from) / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A wall clock that only ticks while something is still running. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!ticking) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [ticking])
  return now
}
