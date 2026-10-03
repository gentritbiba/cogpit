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
import { readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  addUsageCostTotals,
  emptyUsageCostTotals,
  type SessionUsageCostSummary,
  type UsageCostPricingStatus,
  type UsageCostProvider,
  type UsageCostSummary,
  type UsageCostTokenTotals,
} from "../../../shared/contracts/usageCost"
import { descriptorFor } from "../../../shared/session/agent-descriptors"
import { parseRateTable, type RateTable } from "../../../shared/usageCost/pricing"
import { storeForDirName } from "../../agents"
import type { ChildTranscriptFilter } from "../../edition/transcript"
import { allRuntimes, runtimeFor } from "../../agents/runtimes"
import type { UsageCostRecord } from "../../agents/usageScanners"
import { getDataRoot } from "../../config"
import { resolveSessionFilePath, sessionStorageRoots } from "../../sessionPaths"
import {
  aggregateSessionUsage,
  UsageCostAggregator,
  makeDayFormatter,
  type ScopedUsageCostRecord,
} from "./aggregate"
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
/** A fetch that failed can take its whole timeout, so the next one waits this long rather than delaying every read. */
const RATES_RETRY_MS = 5 * 60 * 1000

/**
 * Transcripts are filtered by mtime before opening: one last written this long
 * before a window's start is skipped. The slack covers a window that starts at
 * local rather than UTC midnight, and a child agent that writes on after its
 * session's own transcript last changed.
 */
export const TRANSCRIPT_MTIME_SLACK_MS = 36 * 60 * 60 * 1000

interface CachedFile {
  size: number
  mtimeMs: number
  provider: UsageCostProvider
  records: UsageCostRecord[]
}

const fileCache = new Map<string, CachedFile>()

/** A cached transcript last written longer ago than this has aged out of every window read often. */
const FILE_CACHE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
/** The aged entries are swept out at most this often, as new ones come in. */
const FILE_CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000
let fileCacheSweptAtMs = 0

function cacheFileRecords(path: string, entry: CachedFile): void {
  const now = Date.now()
  if (now - fileCacheSweptAtMs >= FILE_CACHE_SWEEP_INTERVAL_MS) {
    fileCacheSweptAtMs = now
    for (const [cachedPath, cached] of fileCache) {
      if (cached.mtimeMs < now - FILE_CACHE_RETENTION_MS) fileCache.delete(cachedPath)
    }
  }
  fileCache.set(path, entry)
}

let rates: RateTable = new Map()
let ratesFetchedAtMs: number | null = null
let ratesFailedAtMs: number | null = null
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

  if (ratesFailedAtMs !== null && now - ratesFailedAtMs < RATES_RETRY_MS) return

  let document: unknown = null
  try {
    const response = await fetch(LITELLM_RATES_URL, { signal: AbortSignal.timeout(10_000) })
    if (response.ok) document = await response.json()
  } catch {
    // Offline; whatever we already serve stays, honestly marked as cached.
  }
  const parsed = document === null ? null : parseRateTable(document)
  if (parsed === null || parsed.size === 0) {
    ratesFailedAtMs = now
    if (rates.size > 0) ratesStatus = "cached"
    return
  }

  rates = parsed
  ratesFailedAtMs = null
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
  cacheFileRecords(file.path, { size: file.size, mtimeMs: file.mtimeMs, provider, records })
  return records
}

/** What a scan has already attributed, per session and model. */
type CountedUsage = Map<string, Map<string, UsageCostTokenTotals>>

function addCountedUsage(counted: CountedUsage, record: UsageCostRecord): void {
  const byModel = counted.get(record.sessionId) ?? new Map<string, UsageCostTokenTotals>()
  byModel.set(
    record.model,
    addUsageCostTotals(byModel.get(record.model) ?? emptyUsageCostTotals(), record.totals),
  )
  counted.set(record.sessionId, byModel)
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

  const windowStartMs = Date.parse(`${input.sinceDay}T00:00:00Z`) - TRANSCRIPT_MTIME_SLACK_MS

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
  const durableTotals: CountedUsage = new Map()
  let scannedFiles = 0
  for (const { kind: provider, root } of sources) {
    const files = await listTranscriptFiles(root, windowStartMs)
    for (const file of files) {
      const records = await readFileRecords(file, provider)
      scannedFiles += 1
      for (const record of records) {
        aggregator.add(record)
        if (liveSessionIds.has(record.sessionId)) addCountedUsage(durableTotals, record)
      }
    }
  }

  // Usage that only reaches a transcript when its session closes is folded in
  // from the runtimes that still hold those sessions open.
  for (const runtime of runtimes) {
    for (const record of await runtime.liveUsageRecords(durableTotals)) aggregator.add(record)
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

async function transcriptFile(filePath: string): Promise<TranscriptFile | null> {
  try {
    const fileStat = await stat(filePath)
    return { path: filePath, size: fileStat.size, mtimeMs: fileStat.mtimeMs }
  } catch {
    return null
  }
}

function isSubagentAddress(fileName: string): boolean {
  return fileName.split("/").includes("subagents")
}

/** Resolves every child transcript that belongs to the selected top-level session and that `visibleChildren` keeps. */
async function childTranscripts(
  dirName: string,
  rootSessionId: string,
  provider: UsageCostProvider,
  visibleChildren: ChildTranscriptFilter,
): Promise<TranscriptFile[]> {
  const store = storeForDirName(dirName)
  // When descendants carry their own session ids the tree has to be walked;
  // otherwise every one of them is already filed under the root session.
  const nested = descriptorFor(provider).capabilities.nestedSubagents
  const found: TranscriptFile[] = []
  const queuedSessionIds = [rootSessionId]
  const visitedSessionIds = new Set<string>()
  const visitedPaths = new Set<string>()

  while (queuedSessionIds.length > 0) {
    const parentSessionId = queuedSessionIds.shift()!
    if (visitedSessionIds.has(parentSessionId)) continue
    visitedSessionIds.add(parentSessionId)

    const children = await store.listSubagentFiles(dirName, parentSessionId)
    if (!children) continue
    const resolvedChildren = await Promise.all((await visibleChildren(children)).map(async (child) => {
      const fileName = child.fileName
        ?? `${rootSessionId}/subagents/agent-${child.agentId}.jsonl`
      const filePath = await resolveSessionFilePath(dirName, fileName)
      if (!filePath) return null
      const file = await transcriptFile(filePath)
      return file ? { agentId: child.agentId, file } : null
    }))
    for (const child of resolvedChildren) {
      if (!child || visitedPaths.has(child.file.path)) continue
      const { file } = child
      visitedPaths.add(file.path)
      found.push(file)
      if (nested) queuedSessionIds.push(child.agentId)
    }
  }

  return found
}

function countedUsageBySession(
  scopedRecords: readonly ScopedUsageCostRecord[],
): CountedUsage {
  const counted: CountedUsage = new Map()
  for (const { record } of scopedRecords) {
    if (record.sessionId) addCountedUsage(counted, record)
  }
  return counted
}

/** A session's transcript to read usage from, as its caller found or checked it. */
export interface UsageTranscript {
  dirName: string
  fileName: string
  filePath: string
  /** The session it is the transcript of; null for one filed under its session, read alone. */
  sessionId: string | null
  /** Which of the session's child transcripts to read with it: those its caller may see. */
  visibleChildren: ChildTranscriptFilter
}

/** When each session's latest record on disk was stamped. */
function latestRecordBySession(scopedRecords: readonly ScopedUsageCostRecord[]): Map<string, number> {
  const latest = new Map<string, number>()
  for (const { record } of scopedRecords) {
    latest.set(record.sessionId, Math.max(latest.get(record.sessionId) ?? Number.NEGATIVE_INFINITY, record.timestampMs))
  }
  return latest
}

/** One selected session's usage, unpriced and not yet de-duplicated across its files. */
export interface SessionUsageRecords {
  provider: UsageCostProvider
  sessionId: string
  /** Transcripts read: the session's own, then each child agent's. */
  files: number
  records: ScopedUsageCostRecord[]
}

/**
 * Reads one selected session's usage records at transcript fidelity. A
 * top-level session also includes every child-agent transcript the provider
 * can relate to it that `visibleChildren` keeps, and the usage a runtime
 * holding it open has not written.
 */
export async function readSessionUsageRecords(input: UsageTranscript): Promise<SessionUsageRecords | null> {
  const directFile = await transcriptFile(input.filePath)
  if (!directFile) return null

  const provider = storeForDirName(input.dirName).kind
  const directRecords = await readFileRecords(directFile, provider)
  const sessionId =
    input.sessionId
    ?? directRecords.find((record) => record.sessionId.length > 0)?.sessionId
    ?? ""

  const isSubagent = isSubagentAddress(input.fileName)
  const files: Array<{ file: TranscriptFile; isSubagent: boolean }> = [{ file: directFile, isSubagent }]
  if (input.sessionId && !isSubagent) {
    for (const file of await childTranscripts(input.dirName, input.sessionId, provider, input.visibleChildren)) {
      if (file.path !== input.filePath) files.push({ file, isSubagent: true })
    }
  }

  const recordsByFile = await Promise.all(files.map(async ({ file, isSubagent }) => ({
    isSubagent,
    records: await readFileRecords(file, provider),
  })))
  const scopedRecords: ScopedUsageCostRecord[] = recordsByFile.flatMap(
    ({ records, isSubagent }) => records.map((record) => ({ record, isSubagent })),
  )

  // A CLI whose detailed snapshot is durable only at shutdown leaves the
  // transcript behind while the session is open; its runtime supplies the
  // growth since the latest snapshot, which is what accrued after it.
  const sessionIds = new Set<string>()
  for (const { record } of scopedRecords) {
    if (record.sessionId) sessionIds.add(record.sessionId)
  }
  if (sessionId) sessionIds.add(sessionId)
  const runtime = runtimeFor(provider)
  if ([...sessionIds].some((id) => runtime.hasSession(id))) {
    const durableThrough = latestRecordBySession(scopedRecords)
    for (const record of await runtime.liveUsageRecords(countedUsageBySession(scopedRecords), sessionIds)) {
      if (!sessionIds.has(record.sessionId)) continue
      const accruedSinceMs = durableThrough.get(record.sessionId) ?? Number.NEGATIVE_INFINITY
      scopedRecords.push({ record: { ...record, accruedSinceMs }, isSubagent: record.sessionId !== sessionId })
    }
  }

  return { provider, sessionId, files: files.length, records: scopedRecords }
}

/** Prices one selected session's usage records for the Cost tab. */
export async function readSessionUsageCostSummary(input: UsageTranscript): Promise<SessionUsageCostSummary | null> {
  const startedAtMs = Date.now()
  await ensureRates()

  const usage = await readSessionUsageRecords(input)
  if (!usage) return null
  return {
    provider: usage.provider,
    sessionId: usage.sessionId,
    ...aggregateSessionUsage(usage.records, rates),
    includedFiles: usage.files,
    includedSubagents: usage.files - 1,
    pricing: {
      status: ratesStatus,
      knownModels: rates.size,
      fetchedAt: ratesFetchedAt(),
    },
    scanDurationMs: Math.max(0, Date.now() - startedAtMs),
  }
}
