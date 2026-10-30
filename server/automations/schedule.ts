import { AUTOMATION_LIMITS, WEEKDAYS, type AutomationSchedule } from "../../shared/contracts/automations"

/**
 * When a task's schedule is next due. Wall-clock schedules follow their own
 * IANA time zone through daylight-saving changes: a time a spring-forward
 * skips runs at the first moment after the gap, and a time a fall-back
 * repeats runs once, at its first occurrence.
 */

const MINUTE = 60_000
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone)
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    formatters.set(timeZone, found)
  }
  return found
}

/** Whether `timeZone` is one the runtime knows. */
export function isTimeZone(timeZone: string): boolean {
  try { formatter(timeZone); return true } catch { return false }
}

interface Wall { year: number; month: number; day: number; hour: number; minute: number }

function wallAt(timeZone: string, instant: number): Wall {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute) }
}

/** The zone's offset from UTC at `instant`, in milliseconds. */
function offsetAt(timeZone: string, instant: number): number {
  const wall = wallAt(timeZone, instant)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - Math.floor(instant / MINUTE) * MINUTE
}

function sameWall(a: Wall, b: Wall): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute
}

/** The instant a wall-clock time names in `timeZone`, resolved as the schedule's rules say. */
export function zonedInstant(timeZone: string, wall: Wall): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  const before = naive - offsetAt(timeZone, naive - 12 * 60 * MINUTE)
  const after = naive - offsetAt(timeZone, naive + 12 * 60 * MINUTE)
  const valid = [before, after].filter((instant) => sameWall(wallAt(timeZone, instant), wall))
  if (valid.length > 0) return Math.min(...valid)
  // Skipped by a spring-forward: the first minute after the gap, where the offset changes.
  let low = Math.min(before, after)
  let high = Math.max(before, after)
  const lowOffset = offsetAt(timeZone, low)
  while (high - low > MINUTE) {
    const middle = Math.floor((low + high) / 2 / MINUTE) * MINUTE
    if (offsetAt(timeZone, middle) === lowOffset) low = middle
    else high = middle
  }
  return high
}

/** Why a schedule cannot be used, or null. */
export function scheduleProblem(schedule: AutomationSchedule): string | null {
  if (schedule.kind === "interval") {
    const minutes = schedule.everyMinutes
    if (!Number.isInteger(minutes) || minutes < AUTOMATION_LIMITS.minIntervalMinutes || minutes > AUTOMATION_LIMITS.maxIntervalMinutes) return `Run every ${AUTOMATION_LIMITS.minIntervalMinutes} minutes to 30 days`
    return null
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) return "Use a time like 09:30"
  if (schedule.days.length === 0 || schedule.days.some((day) => !WEEKDAYS.includes(day))) return "Pick at least one weekday"
  if (!isTimeZone(schedule.timeZone)) return "Unknown time zone"
  return null
}

/** The first time after `after` that the schedule is due; `anchor` is when an interval started counting. */
export function nextDue(schedule: AutomationSchedule, after: number, anchor: number): number {
  if (schedule.kind === "interval") {
    const step = schedule.everyMinutes * MINUTE
    return anchor + (Math.floor(Math.max(0, after - anchor) / step) + 1) * step
  }
  const [hour, minute] = schedule.time.split(":").map(Number) as [number, number]
  const today = wallAt(schedule.timeZone, after)
  for (let offset = 0; offset <= 8; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset))
    if (!schedule.days.includes(WEEKDAYS[date.getUTCDay()]!)) continue
    const instant = zonedInstant(schedule.timeZone, { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute })
    if (instant > after) return instant
  }
  throw new Error("The schedule has no day to run on")
}
