import { performance } from "node:perf_hooks"

import type { ActivityMetric, ServerPerformanceSnapshot } from "../../src/lib/performanceTypes"

const SAMPLE_WINDOW_SECONDS = 10
const RETAINED_SECONDS = 60
const startedAt = Date.now()

interface MetricValues {
  count: number
  bytes: number
  durationMs: number
}

type MetricBuckets = Map<number, Map<string, MetricValues>>

const activityBuckets: MetricBuckets = new Map()
const requestBuckets: MetricBuckets = new Map()
const activityTotals = new Map<string, number>()
const requestTotals = new Map<string, number>()
const activeGauges = new Map<string, number>()

let previousCpuUsage = process.cpuUsage()
let previousCpuAt = performance.now()
let previousEventLoop = performance.eventLoopUtilization()

function updateMetric(
  buckets: MetricBuckets,
  totals: Map<string, number>,
  name: string,
  values: Partial<MetricValues>,
): void {
  const second = Math.floor(Date.now() / 1000)
  let bucket = buckets.get(second)
  if (!bucket) {
    bucket = new Map()
    buckets.set(second, bucket)
  }

  const current = bucket.get(name) ?? { count: 0, bytes: 0, durationMs: 0 }
  const count = values.count ?? 1
  current.count += count
  current.bytes += values.bytes ?? 0
  current.durationMs += values.durationMs ?? 0
  bucket.set(name, current)
  totals.set(name, (totals.get(name) ?? 0) + count)

  if (buckets.size > RETAINED_SECONDS + 1) {
    const oldestAllowed = second - RETAINED_SECONDS
    for (const key of buckets.keys()) {
      if (key < oldestAllowed) buckets.delete(key)
    }
  }
}

export function recordActivity(
  name: string,
  values: { count?: number; bytes?: number; durationMs?: number } = {},
): void {
  updateMetric(activityBuckets, activityTotals, name, values)
}

export function recordRequest(name: string, durationMs: number): void {
  updateMetric(requestBuckets, requestTotals, name, { durationMs })
}

export function beginActivity(name: string): () => void {
  activeGauges.set(name, (activeGauges.get(name) ?? 0) + 1)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    const next = Math.max(0, (activeGauges.get(name) ?? 1) - 1)
    if (next === 0) activeGauges.delete(name)
    else activeGauges.set(name, next)
  }
}

function metricSnapshots(
  buckets: MetricBuckets,
  totals: Map<string, number>,
  sampleWindowSeconds: number,
  includeGauges: boolean,
): ActivityMetric[] {
  const nowSecond = Math.floor(Date.now() / 1000)
  const earliest = nowSecond - SAMPLE_WINDOW_SECONDS + 1
  const aggregate = new Map<string, MetricValues>()

  for (const [second, bucket] of buckets) {
    if (second < earliest) continue
    for (const [name, values] of bucket) {
      const current = aggregate.get(name) ?? { count: 0, bytes: 0, durationMs: 0 }
      current.count += values.count
      current.bytes += values.bytes
      current.durationMs += values.durationMs
      aggregate.set(name, current)
    }
  }

  if (includeGauges) {
    for (const name of activeGauges.keys()) {
      if (!aggregate.has(name)) aggregate.set(name, { count: 0, bytes: 0, durationMs: 0 })
    }
  }

  return Array.from(aggregate, ([name, values]) => {
    const active = includeGauges ? activeGauges.get(name) : undefined
    return {
      name,
      count: values.count,
      totalCount: totals.get(name) ?? 0,
      ratePerSecond: values.count / sampleWindowSeconds,
      bytesPerSecond: values.bytes / sampleWindowSeconds,
      ...(values.count > 0 && values.durationMs > 0
        ? { averageDurationMs: values.durationMs / values.count }
        : {}),
      ...(active !== undefined ? { active } : {}),
    }
  }).sort((a, b) => {
    const score = (metric: ActivityMetric) => (
      metric.ratePerSecond + metric.bytesPerSecond / 1024 + (metric.active ?? 0)
    )
    return score(b) - score(a)
  })
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function createServerPerformanceSnapshot(): ServerPerformanceSnapshot {
  const now = performance.now()
  const elapsedMicros = Math.max(1, (now - previousCpuAt) * 1000)
  const cpuDelta = process.cpuUsage(previousCpuUsage)
  previousCpuUsage = process.cpuUsage()
  previousCpuAt = now

  const currentEventLoop = performance.eventLoopUtilization()
  const eventLoopDelta = performance.eventLoopUtilization(currentEventLoop, previousEventLoop)
  previousEventLoop = currentEventLoop

  const sampleWindowSeconds = Math.max(
    1,
    Math.min(SAMPLE_WINDOW_SECONDS, (Date.now() - startedAt) / 1000),
  )
  const memory = process.memoryUsage()

  return {
    capturedAt: Date.now(),
    sampleWindowSeconds: round(sampleWindowSeconds, 1),
    cpuPercent: round(((cpuDelta.user + cpuDelta.system) / elapsedMicros) * 100),
    eventLoopPercent: round(eventLoopDelta.utilization * 100),
    uptimeSeconds: round(process.uptime(), 0),
    memory: {
      rssMb: round(memory.rss / 1024 / 1024),
      heapUsedMb: round(memory.heapUsed / 1024 / 1024),
    },
    activities: metricSnapshots(activityBuckets, activityTotals, sampleWindowSeconds, true),
    requests: metricSnapshots(requestBuckets, requestTotals, sampleWindowSeconds, false),
  }
}

export function normalizeApiPath(url: string, method = "GET"): string {
  const pathname = new URL(url, "http://localhost").pathname
  const segments = pathname.split("/").filter(Boolean)
  const root = segments[0] ?? "root"
  const normalized = root === "watch"
    ? "/api/watch/:session"
    : root === "sessions"
      ? "/api/sessions/:project"
      : root === "session"
        ? "/api/session/:id"
        : root === "task-output"
          ? "/api/task-output"
          : `/api/${root}`
  return `${method.toUpperCase()} ${normalized}`
}

/** Test helper: clear counters without changing process-level sampling state. */
export function _resetActivityMonitorForTests(): void {
  activityBuckets.clear()
  requestBuckets.clear()
  activityTotals.clear()
  requestTotals.clear()
  activeGauges.clear()
}
