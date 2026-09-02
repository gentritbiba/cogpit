/**
 * Scans provider transcripts and returns priced usage buckets.
 *
 * Reads the provider CLIs' own session files (the ccusage approach), so usage
 * covers turns driven outside Cogpit too. Transcripts are append-only, so
 * parsed records are memoised in-process per file by `(size, mtime)`: a cold
 * 30-day scan is a couple of seconds, warm scans only reparse changed files.
 *
 * Rates come from LiteLLM's public table, refreshed daily and snapshotted to
 * disk so cost keeps working offline.
 */
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  addUsageCostTotals,
  emptyUsageCostTotals,
  type UsageCostPricingStatus,
  type UsageCostProvider,
  type UsageCostSummary,
  type UsageCostTokenTotals,
} from "../../../shared/contracts/usageCost"
import { parseRateTable, type RateTable } from "../../../shared/usageCost/pricing"
import { allRuntimes } from "../../agents/runtimes"
import type { UsageCostRecord } from "../../agents/usageScanners"
import { getDataRoot } from "../../config"
import { sessionStorageRoots } from "../../sessionPaths"
import { UsageCostAggregator, makeDayFormatter } from "./aggregate"
import {
  dedupeWithinFile,
  listTranscriptFiles,
  readTranscriptRecords,
  type TranscriptFile,
} from "./reader"
export const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000

interface CachedFile {
  size: number
  mtimeMs: number
  provider: UsageCostProvider
  records: UsageCostRecord[]
}

const fileCache = new Map<string, CachedFile>()

let rates: RateTable = new Map()
let ratesFetchedAtMs: number | null = null
let ratesStatus: UsageCostPricingStatus = "unavailable"
let ratesLoad: Promise<void> | null = null

function ratesCachePath(): string {
  return join(getDataRoot(), "usage-model-rates.json")
}

function ratesFetchedAt(): string | null {
  return ratesFetchedAtMs === null ? null : new Date(ratesFetchedAtMs).toISOString()
}

/**
 * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
 * the on-disk snapshot. With neither, every model reports as unpriced rather
 * than the endpoint failing.
 */
async function ensureRatesInner(): Promise<void> {
  const now = Date.now()
  if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return

  if (ratesFetchedAtMs === null) {
    try {
      const raw = JSON.parse(await readFile(ratesCachePath(), "utf8")) as {
        fetchedAtMs?: unknown
        document?: unknown
      }
      if (typeof raw.fetchedAtMs === "number") {
        const parsed = parseRateTable(raw.document)
        if (parsed.size > 0) {
          rates = parsed
          ratesFetchedAtMs = raw.fetchedAtMs
          ratesStatus = "cached"
          if (now - raw.fetchedAtMs < RATES_TTL_MS) return
        }
      }
    } catch {
      // No snapshot yet, or corrupt — a cold fetch follows.
    }
  }

  let document: unknown = null
  try {
    const response = await fetch(LITELLM_RATES_URL, { signal: AbortSignal.timeout(10_000) })
    if (response.ok) document = await response.json()
  } catch {
    // Offline; whatever we already serve stays, honestly marked as cached.
  }
  if (document === null) {
    if (rates.size > 0) ratesStatus = "cached"
    return
  }

  const parsed = parseRateTable(document)
  if (parsed.size === 0) return

  rates = parsed
  ratesFetchedAtMs = now
  ratesStatus = "fresh"

  try {
    await writeFile(ratesCachePath(), JSON.stringify({ fetchedAtMs: now, document }))
  } catch {
    // A snapshot we cannot write is a slower next start, not a failed read.
  }
}

async function ensureRates(): Promise<void> {
  // Concurrent first readers await the same load instead of racing the fetch.
  if (ratesLoad === null) {
    ratesLoad = ensureRatesInner().finally(() => {
      ratesLoad = null
    })
  }
  return ratesLoad
}

/** The live rate table plus provenance, for client-side per-turn pricing. */
export async function getModelRates(): Promise<{
  status: UsageCostPricingStatus
  fetchedAt: string | null
  rates: RateTable
}> {
  await ensureRates()
  return { status: ratesStatus, fetchedAt: ratesFetchedAt(), rates }
}

/** Parses one transcript, reusing the cached result when it is unchanged. */
async function readFileRecords(
  file: TranscriptFile,
  provider: UsageCostProvider,
): Promise<UsageCostRecord[]> {
  const cached = fileCache.get(file.path)
  if (
    cached
    && cached.size === file.size
    && cached.mtimeMs === file.mtimeMs
    && cached.provider === provider
  ) {
    return cached.records
  }

  const parsed = await readTranscriptRecords(file.path, provider)
  // A read failure is not an empty transcript: caching it under this
  // (size, mtime) would silently drop the file's usage until it changes.
  if (parsed === null) return []

  // Stored already de-duplicated within the file, which is 99% of all
  // duplicates. The aggregator still runs the cross-file dedupe pass.
  const records = dedupeWithinFile(parsed)
  fileCache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, provider, records })
  return records
}

/** Inclusive `[sinceDay, untilDay]` covering the trailing `days` in `timeZone`. */
export function makeWindow(days: number, timeZone: string, nowMs = Date.now()): {
  sinceDay: string
  untilDay: string
} {
  const toDay = makeDayFormatter(timeZone)
  return {
    sinceDay: toDay(nowMs - (days - 1) * 24 * 60 * 60 * 1000),
    untilDay: toDay(nowMs),
  }
}

export async function readUsageCostSummary(input: {
  sinceDay: string
  untilDay: string
  timeZone: string
}): Promise<UsageCostSummary> {
  const startedAtMs = Date.now()
  await ensureRates()

  const windowStartMs = Date.parse(`${input.sinceDay}T00:00:00Z`) - MTIME_SLACK_MS

  const aggregator = new UsageCostAggregator({
    timeZone: input.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    rates,
  })

  const sources = sessionStorageRoots()

  // What the durable scan attributed per session and model, for the sessions a
  // runtime still holds open, so one reporting cumulative live totals can hand
  // back only the growth.
  const runtimes = allRuntimes()
  const liveSessionIds = new Set(
    runtimes.flatMap((runtime) => runtime.listActive().map((active) => active.sessionId)),
  )
  const durableTotals = new Map<string, Map<string, UsageCostTokenTotals>>()
  let scannedFiles = 0
  for (const { kind: provider, root } of sources) {
    const files = await listTranscriptFiles(root, windowStartMs)
    for (const file of files) {
      const records = await readFileRecords(file, provider)
      scannedFiles += 1
      for (const record of records) {
        aggregator.add(record)
        if (!liveSessionIds.has(record.sessionId)) continue
        const byModel = durableTotals.get(record.sessionId) ?? new Map()
        byModel.set(
          record.model,
          addUsageCostTotals(
            byModel.get(record.model) ?? emptyUsageCostTotals(),
            record.totals,
          ),
        )
        durableTotals.set(record.sessionId, byModel)
      }
    }
  }

  // Usage that only reaches a transcript when its session closes is folded in
  // from the runtimes that still hold those sessions open.
  for (const runtime of runtimes) {
    for (const record of await runtime.liveUsageRecords(durableTotals)) aggregator.add(record)
  }

  // Entries whose files aged out of every plausible window stop paying rent.
  const retentionCutoffMs = startedAtMs - 90 * 24 * 60 * 60 * 1000
  for (const [path, entry] of fileCache) {
    if (entry.mtimeMs < retentionCutoffMs) fileCache.delete(path)
  }

  const { buckets, distinctSessions } = aggregator.finish()

  return {
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    timeZone: input.timeZone,
    buckets,
    pricing: {
      status: ratesStatus,
      knownModels: rates.size,
      fetchedAt: ratesFetchedAt(),
    },
    scannedFiles,
    distinctSessions,
    scanDurationMs: Math.max(0, Date.now() - startedAtMs),
  }
}
