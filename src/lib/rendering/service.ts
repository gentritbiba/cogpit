import type { ThemedToken } from "shiki/core"
import { computeDiffDeferred, type DiffLine } from "./diff"
import { outputBytes, type RenderInput, type RenderOutput, type RenderRequest, type RenderResponse } from "./protocol"

export const RENDER_LIMITS = {
  cacheEntries: 48,
  cacheBytes: 8 * 1024 * 1024,
  queueEntries: 32,
  queueBytes: 8 * 1024 * 1024,
  jobBytes: 16 * 1024 * 1024,
  highlightChars: 200_000,
  highlightBytes: 400_000,
  idleMs: 30_000,
  timeoutMs: 30_000,
} as const

export interface RenderWorker {
  onmessage: ((event: MessageEvent<RenderResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
  postMessage(message: RenderRequest): void
  terminate(): void
}
interface Waiter { resolve: (value: RenderOutput) => void; reject: (error: unknown) => void; detach: () => void }
interface Job {
  id: number
  key: string
  input: RenderInput
  bytes: number
  workerAllowed: boolean
  waiters: Set<Waiter>
  controller: AbortController
}
const aborted = () => new DOMException("Aborted", "AbortError")

/** One lazy worker, shared in-flight requests, bounded LRU and FIFO admission. */
export class RenderWorkService {
  private worker: RenderWorker | null = null
  private active: Job | null = null
  private queue: Job[] = []
  private jobs = new Map<string, Job>()
  private cache = new Map<string, { value: RenderOutput; bytes: number }>()
  private cacheBytes = 0
  private queuedBytes = 0
  private nextId = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private workTimer: ReturnType<typeof setTimeout> | undefined
  private retryAfter = 0

  constructor(private readonly createWorker: () => RenderWorker = () => new Worker(new URL("./render.worker.ts", import.meta.url), { type: "module" })) {}

  highlight(code: string, lang: string, isDark: boolean, signal?: AbortSignal): Promise<ThemedToken[][] | null> {
    if (signal?.aborted) return Promise.reject(aborted())
    if (code.length > RENDER_LIMITS.highlightChars || code.length * 2 > RENDER_LIMITS.highlightBytes) return Promise.resolve(null)
    return this.request({ kind: "highlight", code, lang, isDark }, signal) as Promise<ThemedToken[][] | null>
  }

  diff(oldString: string, newString: string, signal?: AbortSignal): Promise<DiffLine[] | null> {
    if ((oldString.length + newString.length) * 2 > RENDER_LIMITS.jobBytes / 2) return this.oversizedDiff(oldString, newString, signal)
    return this.request({ kind: "diff", oldString, newString }, signal) as Promise<DiffLine[] | null>
  }

  private request(input: RenderInput, signal?: AbortSignal): Promise<RenderOutput> {
    if (signal?.aborted) return Promise.reject(aborted())
    const key = JSON.stringify(input)
    const bytes = key.length * 2 + (input.kind === "diff" ? input.oldString.length + input.newString.length : input.code.length) * 2 + 256
    if (bytes > RENDER_LIMITS.jobBytes || bytes > RENDER_LIMITS.queueBytes) {
      return input.kind === "diff" ? this.oversizedDiff(input.oldString, input.newString, signal) : Promise.resolve(null)
    }
    const cached = this.cache.get(key)
    if (cached) {
      this.cache.delete(key)
      this.cache.set(key, cached)
      this.scheduleIdle()
      return Promise.resolve(cached.value)
    }
    let job = this.jobs.get(key)
    if (!job) {
      // Saturation leaves highlighting plain and asks diff consumers to retry.
      if (this.queue.length >= RENDER_LIMITS.queueEntries || (this.active && this.queuedBytes + bytes > RENDER_LIMITS.queueBytes)) return Promise.resolve(null)
      job = { id: ++this.nextId, key, input, bytes, workerAllowed: true, waiters: new Set(), controller: new AbortController() }
      this.jobs.set(key, job)
      this.queue.push(job)
      this.queuedBytes += bytes
    }
    return this.subscribe(job, signal)
  }

  private oversizedDiff(oldString: string, newString: string, signal?: AbortSignal): Promise<DiffLine[] | null> {
    if (signal?.aborted) return Promise.reject(aborted())
    const current = this.active
    if (current && !current.workerAllowed && current.input.kind === "diff" && current.input.oldString === oldString && current.input.newString === newString) {
      return this.subscribe(current, signal) as Promise<DiffLine[]>
    }
    // Borrow oversized sources without stringifying/copying or queuing them.
    // Only one cooperative recovery runs, sharing the normal service's lane.
    if (current || this.queue.length) return Promise.resolve(null)
    const id = ++this.nextId
    const job: Job = { id, key: `oversized:${id}`, input: { kind: "diff", oldString, newString }, bytes: 256, workerAllowed: false, waiters: new Set(), controller: new AbortController() }
    this.jobs.set(job.key, job)
    this.queue.push(job)
    this.queuedBytes += job.bytes
    return this.subscribe(job, signal) as Promise<DiffLine[]>
  }

  private subscribe(target: Job, signal?: AbortSignal): Promise<RenderOutput> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        target.waiters.delete(waiter)
        waiter.detach()
        reject(aborted())
        if (!target.waiters.size) this.cancel(target)
      }
      const waiter: Waiter = { resolve, reject, detach: () => signal?.removeEventListener("abort", onAbort) }
      target.waiters.add(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
      clearTimeout(this.idleTimer)
      this.pump()
    })
  }

  private pump(): void {
    if (this.active) return
    const job = this.queue.shift()
    if (!job) { this.scheduleIdle(); return }
    this.queuedBytes -= job.bytes
    this.active = job
    if (!job.workerAllowed) { this.fallback(job); return }
    if (!this.worker && Date.now() >= this.retryAfter) {
      try {
        const worker = this.createWorker()
        worker.onmessage = event => {
          if (this.worker !== worker || this.active?.id !== event.data.id) return
          if (event.data.error) this.recover()
          else this.finish(this.active, event.data.result)
        }
        worker.onerror = () => { if (this.worker === worker) this.recover() }
        worker.onmessageerror = () => { if (this.worker === worker) this.recover() }
        this.worker = worker
      } catch { this.retryAfter = Date.now() + 1000 }
    }
    if (!this.worker) { this.fallback(job); return }
    this.workTimer = setTimeout(() => this.recover(), RENDER_LIMITS.timeoutMs)
    try { this.worker.postMessage({ id: job.id, input: job.input }) }
    catch { this.recover() }
  }

  private fallback(job: Job): void {
    if (job.input.kind === "highlight") { this.finish(job, null); return }
    void computeDiffDeferred(job.input.oldString, job.input.newString, job.controller.signal)
      .then(value => this.finish(job, value))
      .catch(error => {
        if (this.active !== job) return
        for (const waiter of job.waiters) { waiter.detach(); waiter.reject(error) }
        this.release(job)
      })
  }

  private recover(): void {
    const job = this.active
    this.stopWorker()
    this.retryAfter = Date.now() + 1000
    if (job) this.fallback(job)
  }

  private finish(job: Job, value: RenderOutput): void {
    if (this.active !== job) return
    const bytes = job.workerAllowed ? job.key.length * 2 + outputBytes(value) + 128 : Infinity
    if (value && bytes <= RENDER_LIMITS.cacheBytes) {
      while (this.cache.size >= RENDER_LIMITS.cacheEntries || this.cacheBytes + bytes > RENDER_LIMITS.cacheBytes) {
        const oldest = this.cache.entries().next().value!
        this.cache.delete(oldest[0])
        this.cacheBytes -= oldest[1].bytes
      }
      this.cache.set(job.key, { value, bytes })
      this.cacheBytes += bytes
    }
    for (const waiter of job.waiters) { waiter.detach(); waiter.resolve(value) }
    this.release(job)
  }

  private release(job: Job): void {
    clearTimeout(this.workTimer)
    this.jobs.delete(job.key)
    job.waiters.clear()
    this.active = null
    this.pump()
  }

  private cancel(job: Job): void {
    job.controller.abort()
    if (this.active === job) {
      // Synchronous tokenization cannot observe AbortSignal: termination actually
      // stops obsolete CPU work, then queued live consumers acquire a fresh worker.
      this.stopWorker()
      this.release(job)
    } else {
      this.queue = this.queue.filter(candidate => candidate !== job)
      this.queuedBytes -= job.bytes
      this.jobs.delete(job.key)
    }
  }

  private stopWorker(): void {
    clearTimeout(this.workTimer)
    this.worker?.terminate()
    this.worker = null
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.active || this.queue.length) return
      this.stopWorker()
      this.cache.clear()
      this.cacheBytes = 0
    }, RENDER_LIMITS.idleMs)
  }

  dispose(): void {
    for (const job of this.jobs.values()) {
      job.controller.abort()
      for (const waiter of job.waiters) { waiter.detach(); waiter.reject(aborted()) }
    }
    this.stopWorker()
    clearTimeout(this.idleTimer)
    this.active = null
    this.queue = []
    this.jobs.clear()
    this.cache.clear()
    this.cacheBytes = this.queuedBytes = 0
  }

  stats() { return { cachedEntries: this.cache.size, cacheBytes: this.cacheBytes, queuedEntries: this.queue.length, queuedBytes: this.queuedBytes, active: !!this.active, worker: !!this.worker } }
}

export const renderWork = new RenderWorkService()
