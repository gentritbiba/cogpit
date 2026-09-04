/**
 * Folds parsed transcript records into `(day, provider, model)` buckets.
 *
 * Pure, so bucketing and de-duplication rules are testable without touching
 * the filesystem or the network.
 */
import type {
  SessionUsageCostBreakdown,
  SessionUsageCostModel,
  SessionUsageCostSummary,
  UsageCostBucket,
  UsageCostProvider,
  UsageCostSource,
  UsageCostTokenTotals,
} from "../../../shared/contracts/usageCost"
import {
  addUsageCostTotals,
  emptyUsageCostTotals,
  totalUsageCostTokens,
} from "../../../shared/contracts/usageCost"
import {
  cacheSavingsUsd,
  priceUsage,
  totalUsageCostBreakdown,
  usageCostBreakdown,
  type RateTable,
  type UsageCostBreakdown,
} from "../../../shared/usageCost/pricing"
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
      record.speed,
    )

    bucket.totals = addUsageCostTotals(bucket.totals, record.totals)
    bucket.costUsd += priced.costUsd
    bucket.cacheSavingsUsd += cacheSavingsUsd(
      this.#options.rates,
      record.model,
      record.totals,
      record.speed,
    )
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
/** A bucket is only as trustworthy as its least-priced record. */
function resolveCostSource(
  counts: { unpricedRecords: number; providerReportedRecords: number; records: number },
): UsageCostSource {
  if (counts.unpricedRecords === counts.records) return "unpriced"
  if (counts.providerReportedRecords === counts.records) return "providerReported"
  return "modelPriced"
}

export interface ScopedUsageCostRecord {
  record: UsageCostRecord
  isSubagent: boolean
}

type AggregatedSessionUsage = Omit<
  SessionUsageCostSummary,
  "provider" | "sessionId" | "includedFiles" | "includedSubagents" | "pricing" | "scanDurationMs"
>

interface MutableSessionModel {
  model: string
  totals: UsageCostTokenTotals
  costUsd: number
  cacheSavingsUsd: number
  records: number
  providerReportedRecords: number
  unpricedRecords: number
}

function emptyCostBreakdown(): SessionUsageCostBreakdown {
  return {
    uncachedInputUsd: 0,
    cachedInputUsd: 0,
    cacheCreationUsd: 0,
    outputUsd: 0,
    unallocatedUsd: 0,
  }
}

/**
 * Keeps the token-class rows reconciled with provider-reported totals. A
 * reported total is stronger evidence than today's rate table, while the rate
 * proportions remain the only honest way to assign that total across classes.
 */
function addRecordCostBreakdown(
  target: SessionUsageCostBreakdown,
  calculated: UsageCostBreakdown | null,
  pricedCostUsd: number,
): void {
  if (calculated === null) {
    target.unallocatedUsd += pricedCostUsd
    return
  }

  const calculatedTotal = totalUsageCostBreakdown(calculated)
  if (calculatedTotal <= 0) {
    target.unallocatedUsd += pricedCostUsd
    return
  }

  const scale = pricedCostUsd / calculatedTotal
  target.uncachedInputUsd += calculated.uncachedInputUsd * scale
  target.cachedInputUsd += calculated.cachedInputUsd * scale
  target.cacheCreationUsd += calculated.cacheCreationUsd * scale
  target.outputUsd += calculated.outputUsd * scale
}

/**
 * Aggregates one selected transcript plus any child-agent transcripts. The
 * caller resolves files; this function owns pricing, global de-duplication and
 * the detailed response shape used by the Cost tab.
 */
export function aggregateSessionUsage(
  scopedRecords: readonly ScopedUsageCostRecord[],
  rates: RateTable,
): AggregatedSessionUsage {
  const seen = new Set<string>()
  let totals = emptyUsageCostTotals()
  const breakdown = emptyCostBreakdown()
  const models = new Map<string, MutableSessionModel>()
  const calls: SessionUsageCostSummary["calls"] = []
  let costUsd = 0
  let cacheSavings = 0
  let providerReportedRecords = 0
  let modelPricedRecords = 0
  let unpricedRecords = 0

  for (const { record, isSubagent } of scopedRecords) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue
      seen.add(record.dedupeKey)
    }

    const priced = priceUsage(rates, record.model, record.totals, record.reportedCostUsd, record.speed)
    const recordSavings = cacheSavingsUsd(rates, record.model, record.totals, record.speed)
    const calculated = usageCostBreakdown(rates, record.model, record.totals, record.speed)

    totals = addUsageCostTotals(totals, record.totals)
    costUsd += priced.costUsd
    cacheSavings += recordSavings
    addRecordCostBreakdown(breakdown, calculated, priced.costUsd)

    if (priced.costSource === "providerReported") providerReportedRecords += 1
    else if (priced.costSource === "modelPriced") modelPricedRecords += 1
    else unpricedRecords += 1

    let model = models.get(record.model)
    if (!model) {
      model = {
        model: record.model,
        totals: emptyUsageCostTotals(),
        costUsd: 0,
        cacheSavingsUsd: 0,
        records: 0,
        providerReportedRecords: 0,
        unpricedRecords: 0,
      }
      models.set(record.model, model)
    }
    model.totals = addUsageCostTotals(model.totals, record.totals)
    model.costUsd += priced.costUsd
    model.cacheSavingsUsd += recordSavings
    model.records += 1
    if (priced.costSource === "providerReported") model.providerReportedRecords += 1
    if (priced.costSource === "unpriced") model.unpricedRecords += 1

    calls.push({
      timestamp: new Date(record.timestampMs).toISOString(),
      model: record.model,
      totals: record.totals,
      costUsd: priced.costUsd,
      costSource: priced.costSource,
      isSubagent,
    })
  }

  const modelRows: SessionUsageCostModel[] = [...models.values()]
    .map((model) => ({
      model: model.model,
      totals: model.totals,
      costUsd: model.costUsd,
      cacheSavingsUsd: model.cacheSavingsUsd,
      costSource: resolveCostSource(model),
      records: model.records,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || totalUsageCostTokens(b.totals) - totalUsageCostTokens(a.totals))

  calls.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  return {
    totals,
    costUsd,
    cacheSavingsUsd: cacheSavings,
    breakdown,
    models: modelRows,
    calls,
    records: calls.length,
    providerReportedRecords,
    modelPricedRecords,
    unpricedRecords,
  }
}
