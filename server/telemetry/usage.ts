import type { UsageCostSummary } from "../../shared/contracts/usageCost"
import { publicModelName } from "../agents/publicModels"
import type { TelemetryEvents } from "./events"

const DAY_MS = 24 * 60 * 60 * 1000
/** An install that was off for longer reports only its most recent days. */
const MAX_DAYS_BEHIND = 7

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function nextDay(day: string): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + DAY_MS)
}

/**
 * The finished UTC days not yet reported, oldest first. Today is never one: its
 * usage is still growing. With no day reported yet there is nothing to catch
 * up on, so counting starts from today.
 */
export function daysToReport(reportedThrough: string | null, now: number): string[] {
  const yesterday = utcDay(now - DAY_MS)
  if (!reportedThrough || reportedThrough >= yesterday) return []
  const earliest = utcDay(now - MAX_DAYS_BEHIND * DAY_MS)
  const days: string[] = []
  for (let day = nextDay(reportedThrough); day <= yesterday; day = nextDay(day)) {
    if (day >= earliest) days.push(day)
  }
  return days
}

export type ReadDailyUsage = (day: string, sessionIds: ReadonlySet<string>) => Promise<UsageCostSummary>

/** One `usage.daily` event per agent and model that did work that day. */
export function usageEvents(day: string, summary: UsageCostSummary): Array<TelemetryEvents["usage.daily"]> {
  const merged = new Map<string, TelemetryEvents["usage.daily"]>()
  for (const bucket of summary.buckets) {
    if (bucket.day !== day) continue
    const model = publicModelName(bucket.model) ?? "unknown"
    const key = `${bucket.provider}\0${model}`
    const event = merged.get(key) ?? {
      day,
      agent: bucket.provider,
      model,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      responses: 0,
      sessions: 0,
      costUsd: 0,
      costSource: bucket.costSource,
    }
    event.inputTokens += bucket.totals.uncachedInputTokens
    event.cachedInputTokens += bucket.totals.cachedInputTokens
    event.cacheWriteTokens += bucket.totals.cacheCreationTokens
    event.outputTokens += bucket.totals.outputTokens
    event.reasoningTokens += bucket.totals.reasoningTokens
    event.responses += bucket.records
    event.sessions += bucket.sessions
    event.costUsd += bucket.costUsd
    if (event.costSource !== bucket.costSource) event.costSource = "mixed"
    merged.set(key, event)
  }
  return [...merged.values()]
}
