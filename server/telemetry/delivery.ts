import { randomUUID } from "node:crypto"
import type { TelemetryProperties } from "./events"

export interface QueuedEvent {
  uuid: string
  event: string
  timestamp: string
  properties: TelemetryProperties
}

export interface DeliveryOptions {
  endpoint: string
  installId: string
  fetch: typeof fetch
  now?: () => number
  random?: () => number
  maxQueued?: number
  batchSize?: number
}

const SEND_TIMEOUT_MS = 10_000
/** A batch that keeps failing is retried for this long, then dropped. */
const MAX_BATCH_RETRY_MS = 30 * 60_000
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 5 * 60_000
/** These reject the batch itself; sending it again cannot help. */
const REJECTED = new Set([400, 401, 403, 413, 422])

/**
 * Holds events in memory and sends them in batches. The endpoint de-duplicates
 * by `uuid`, so a batch it stored before a failed response may safely go again.
 * A batch that keeps failing holds newer events back until it is dropped, and
 * the queue keeps only the newest `maxQueued` meanwhile.
 */
export class TelemetryDelivery {
  private queue: QueuedEvent[] = []
  private failed: QueuedEvent[] = []
  private firstFailedAt = 0
  private failures = 0
  private retryAt = 0
  private sending: Promise<void> | null = null
  private readonly now: () => number
  private readonly random: () => number
  private readonly maxQueued: number
  private readonly batchSize: number

  constructor(private readonly options: DeliveryOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.maxQueued = options.maxQueued ?? 1_000
    this.batchSize = options.batchSize ?? 50
  }

  enqueue(event: string, properties: TelemetryProperties, timestamp = new Date(this.now())): QueuedEvent {
    const queued: QueuedEvent = { uuid: randomUUID(), event, timestamp: timestamp.toISOString(), properties }
    this.queue.push(queued)
    if (this.queue.length > this.maxQueued) this.queue.splice(0, this.queue.length - this.maxQueued)
    return queued
  }

  get pending(): number {
    return this.queue.length + this.failed.length
  }

  /** Forget everything not yet sent. */
  clear(): void {
    this.queue = []
    this.failed = []
    this.failures = 0
    this.retryAt = 0
  }

  /** Send what is queued, unless a failed batch is still waiting out its backoff. */
  flushWhenDue(): Promise<void> {
    return this.now() >= this.retryAt ? this.flush() : Promise.resolve()
  }

  flush(): Promise<void> {
    this.sending ??= this.sendAll().finally(() => { this.sending = null })
    return this.sending
  }

  private async sendAll(): Promise<void> {
    for (;;) {
      const batch = this.failed.length > 0 ? this.failed : this.queue.splice(0, this.batchSize)
      if (batch.length === 0) return
      const status = await this.send(batch)
      if (status === "ok") {
        this.failed = []
        this.failures = 0
        this.retryAt = 0
        continue
      }
      const now = this.now()
      if (this.failed.length === 0) this.firstFailedAt = now
      this.failures += 1
      const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1))
      this.retryAt = now + Math.round(ceiling / 2 + (ceiling / 2) * this.random())
      this.failed = status === "rejected" || now - this.firstFailedAt >= MAX_BATCH_RETRY_MS ? [] : batch
      return
    }
  }

  private async send(batch: QueuedEvent[]): Promise<"ok" | "failed" | "rejected"> {
    try {
      const response = await this.options.fetch(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installId: this.options.installId, batch }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (response.ok) return "ok"
      return REJECTED.has(response.status) ? "rejected" : "failed"
    } catch {
      return "failed"
    }
  }
}
