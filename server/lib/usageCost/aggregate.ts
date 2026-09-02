/**
 * Folds parsed transcript records into `(day, provider, model)` buckets.
 *
 * Pure, so bucketing and de-duplication rules are testable without touching
 * the filesystem or the network.
 */
import type {
  UsageCostBucket,
  UsageCostProvider,
  UsageCostSource,
  UsageCostTokenTotals,
} from "../../../shared/contracts/usageCost"
import { addUsageCostTotals, emptyUsageCostTotals } from "../../../shared/contracts/usageCost"
import { cacheSavingsUsd, priceUsage, type RateTable } from "../../../shared/usageCost/pricing"
import type { UsageCostRecord } from "../../agents/usageScanners"

/**
 * Formats an instant as a `YYYY-MM-DD` day in `timeZone`. `en-CA` yields
 * ISO-ordered parts; an unknown zone degrades to UTC rather than failing.
 */
export function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  } as const
  try {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, ...options })
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...options })
  }
  return (timestampMs) => format.format(new Date(timestampMs))
}

interface MutableBucket {
  day: string
  provider: UsageCostProvider
  model: string
  totals: UsageCostTokenTotals
  costUsd: number
  cacheSavingsUsd: number
  records: number
  unpricedRecords: number
  providerReportedRecords: number
  sessions: Set<string>
}

export interface AggregateOptions {
  timeZone: string
  sinceDay: string
  untilDay: string
  rates: RateTable
}

export interface AggregateResult {
  buckets: UsageCostBucket[]
  /** Distinct sessions across the window; bucket-level counts overlap. */
  distinctSessions: number
}

/** Model names may contain anything printable, so keys join on an unusable byte. */
const KEY_SEPARATOR = "\u0000"

/**
 * Accumulates records across many files. De-duplication is global across the
 * whole scan, not per file: Claude Code copies a message's records forward
 * when a session is resumed or forked, so the same `dedupeKey` legitimately
 * appears in several transcripts.
 */
export class UsageCostAggregator {
  readonly #buckets = new Map<string, MutableBucket>()
  readonly #seen = new Set<string>()
  readonly #sessions = new Set<string>()
  readonly #toDay: (timestampMs: number) => string
  readonly #options: AggregateOptions

  constructor(options: AggregateOptions) {
    this.#options = options
    this.#toDay = makeDayFormatter(options.timeZone)
  }

  /** Folds one record in; returns whether it actually contributed. */
  add(record: UsageCostRecord): boolean {
    if (record.dedupeKey !== null) {
      if (this.#seen.has(record.dedupeKey)) return false
      this.#seen.add(record.dedupeKey)
    }

    const day = this.#toDay(record.timestampMs)
    if (day < this.#options.sinceDay || day > this.#options.untilDay) return false

    const key = [day, record.provider, record.model].join(KEY_SEPARATOR)
    let bucket = this.#buckets.get(key)
    if (bucket === undefined) {
      bucket = {
        day,
        provider: record.provider,
        model: record.model,
        totals: emptyUsageCostTotals(),
        costUsd: 0,
        cacheSavingsUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
      }
      this.#buckets.set(key, bucket)
    }

    const priced = priceUsage(
      this.#options.rates,
      record.model,
      record.totals,
      record.reportedCostUsd,
    )

    bucket.totals = addUsageCostTotals(bucket.totals, record.totals)
    bucket.costUsd += priced.costUsd
    bucket.cacheSavingsUsd += cacheSavingsUsd(this.#options.rates, record.model, record.totals)
    bucket.records += 1
    if (priced.costSource === "unpriced") bucket.unpricedRecords += 1
    if (priced.costSource === "providerReported") bucket.providerReportedRecords += 1
    if (record.sessionId.length > 0) {
      bucket.sessions.add(record.sessionId)
      this.#sessions.add(record.sessionId)
    }
    return true
  }

  finish(): AggregateResult {
    const buckets: UsageCostBucket[] = []
    for (const bucket of this.#buckets.values()) {
      buckets.push({
        day: bucket.day,
        provider: bucket.provider,
        model: bucket.model,
        totals: bucket.totals,
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        sessions: bucket.sessions.size,
      })
    }
    // Stable ordering keeps payloads diffable.
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day)
        || a.provider.localeCompare(b.provider)
        || a.model.localeCompare(b.model),
    )
    return { buckets, distinctSessions: this.#sessions.size }
  }
}

/**
 * A bucket mixes records from one model, but their cost provenance can differ
 * when only some records carried a reported cost. The weakest provenance wins
 * so the UI never overstates confidence.
 */
function resolveCostSource(bucket: MutableBucket): UsageCostSource {
  if (bucket.unpricedRecords === bucket.records) return "unpriced"
  if (bucket.providerReportedRecords === bucket.records) return "providerReported"
  return "modelPriced"
}
