/**
 * Keeps the memory store current from inside the server. Reconcile is the
 * correctness path: on start and on a backstop timer every transcript of every
 * store is compared with the store and the difference is synced, one file at a
 * time with a yield between files. A written transcript only makes the next
 * pass come sooner. Pending chunks are embedded after each pass when an
 * embedding endpoint is configured.
 */
import type { SessionSearchIndexing } from "../../shared/contracts/sessionSearch"
import type { EmbeddingClient } from "../../shared/memory/embeddings"
import { reconcileStore } from "../../shared/memory/reconcile"
import { MemoryStoreUnavailableError } from "../../shared/memory/schema"
import type { MemoryStore } from "../../shared/memory/store"
import type { SourceFile } from "../../shared/memory/types"
import type { ParsedSession } from "../../shared/session/types"

export interface Embedder {
  /** Embeds queries too, for a search that wants meaning. */
  readonly client: EmbeddingClient
  /** Embed what is pending. Never throws for a down endpoint: it answers with `error`. */
  embedPending(store: MemoryStore, signal: AbortSignal): Promise<{ embedded: number; remaining: number; error?: string }>
}

export interface EmbeddingConfigFile {
  /** The file's text, null when there is none. */
  text: string | null
  /** Changes whenever the file does. */
  stamp: string
}

export interface MemoryIndexerOptions {
  /** Throws `MemoryStoreUnavailableError` when the store cannot work here. */
  openStore(): MemoryStore
  listFiles(): Promise<SourceFile[]>
  /** The transcript parsed with `skipStats`; null when it is gone. */
  parse(file: SourceFile): Promise<ParsedSession | null>
  /** The title the session list shows for a session's own transcript, null when it has none of its own. */
  title(file: SourceFile): Promise<string | null>
  readEmbeddingConfig(): Promise<EmbeddingConfigFile>
  /** The embedder a config file describes; null when it configures none. */
  createEmbedder(configText: string | null): Embedder | null
  warn?(message: string): void
  /** How long between passes when nothing hints at a change. */
  backstopMs?: number
  /** Awaited between files; a yield to the event loop by default. */
  pause?(): Promise<void>
  /** How long after `start` the first pass runs, so it never competes with the server starting up. */
  startDelayMs?: number
}

export interface MemoryIndexer {
  start(): void
  /** A transcript was written: run the next pass sooner. */
  hint(): void
  /**
   * The embedding configuration was changed: use it from now on. A run still
   * embedding for the endpoint it replaced is cancelled, and a pass follows.
   */
  reloadEmbeddings(): Promise<void>
  stop(): Promise<void>
  /** The open store; null before the first pass opens it, after `stop`, or when the store cannot work here. */
  store(): MemoryStore | null
  embedder(): Embedder | null
  /** Why embedding is stopped: the endpoint's last failure or an unusable configuration. Null while it works or is off. */
  embeddingError(): string | null
  counts(): SessionSearchIndexing
  /** Resolves once no pass is running; for tests and measurements. */
  settled(): Promise<void>
}

const BACKSTOP_MS = 5 * 60_000
const START_DELAY_MS = 15_000
/** A pass costs at most a tenth of the time, and a written transcript is re-read at most this often. */
const COST_FACTOR = 10
const MIN_HINT_DELAY_MS = 2_000
const MIN_RESYNC_MS = 5_000
const MAX_RESYNC_MS = 60 * 60_000
/**
 * Reading a transcript this slow blocks the event loop for about that long
 * (a 240 MB one takes about a second), so while it is being written it waits
 * until it has been quiet this long, and never longer than the cap.
 */
const HEAVY_READ_MS = 250
const QUIET_MS = 60_000
const MAX_HEAVY_DEFER_MS = 10 * 60_000
/** A down embedding endpoint is retried after this, doubling up to the cap. */
const EMBED_RETRY_MS = 30_000
const MAX_EMBED_RETRY_MS = 30 * 60_000
/** When an embedding pass stopped with work left and no error, the next one starts this soon. */
const EMBED_CONTINUE_MS = 1_000

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve))

export function createMemoryIndexer(options: MemoryIndexerOptions): MemoryIndexer {
  const backstopMs = options.backstopMs ?? BACKSTOP_MS
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const controller = new AbortController()

  let store: MemoryStore | null = null
  let unavailable = false
  let started = false
  let stopped = false
  let running: Promise<void> | null = null
  let rerun = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerAt = Infinity
  let lastPassMs = 0
  let lastPassEnd = 0

  const resyncAt = new Map<string, number>()
  /** When the stale transcripts the last pass held back may be read. */
  let heldBackUntil = Infinity
  const failures = new Map<string, number>()
  /** When each heavy transcript was last read. */
  const heavyReadAt = new Map<string, number>()
  let pendingFiles = 0

  let embedder: Embedder | null = null
  let configStamp: string | null = null
  let pendingEmbeddings = 0
  let outage: { failures: number; retryAt: number; error: string } | null = null
  let configError: string | null = null
  let embedMoreSoon = false
  /** Cancels the embedding run under way, which belongs to the embedder it started with. */
  let embedRun: AbortController | null = null

  function scheduleAt(at: number): void {
    if (stopped || at >= timerAt) return
    if (timer) clearTimeout(timer)
    timerAt = at
    timer = setTimeout(() => {
      timer = null
      timerAt = Infinity
      runPass()
    }, Math.max(0, at - Date.now()))
    timer.unref?.()
  }

  function runPass(): void {
    if (stopped) return
    if (running) {
      rerun = true
      return
    }
    running = pass()
      .catch((error: unknown) => warn(`[memory] indexing pass failed: ${String(error)}`))
      .finally(() => {
        running = null
        afterPass()
      })
  }

  function afterPass(): void {
    if (stopped || unavailable) return
    const now = Date.now()
    let next = now + backstopMs
    if (rerun) next = Math.min(next, lastPassEnd + hintDelay())
    rerun = false
    next = Math.min(next, heldBackUntil)
    if (embedMoreSoon) next = Math.min(next, now + EMBED_CONTINUE_MS)
    if (outage) next = Math.min(next, outage.retryAt)
    for (const [path, at] of resyncAt) if (at < now - MAX_RESYNC_MS) resyncAt.delete(path)
    scheduleAt(next)
  }

  function hintDelay(): number {
    return Math.max(MIN_HINT_DELAY_MS, lastPassMs * COST_FACTOR)
  }

  function openStore(): MemoryStore | null {
    if (store || unavailable) return store
    try {
      store = options.openStore()
    } catch (error) {
      unavailable = true
      if (!(error instanceof MemoryStoreUnavailableError)) warn(`[memory] session search is off: ${String(error)}`)
    }
    return store
  }

  /**
   * A transcript that is being written is re-read at most a tenth of the time,
   * a heavy one only once it is quiet, and a failing one less often each time.
   */
  async function parseCooperatively(file: SourceFile): Promise<ParsedSession | null> {
    const now = Date.now()
    const holdBack = (until: number) => {
      heldBackUntil = Math.min(heldBackUntil, until)
      return null
    }
    const allowedAt = resyncAt.get(file.path) ?? 0
    if (allowedAt > now) return holdBack(allowedAt)
    const heavyAt = heavyReadAt.get(file.path)
    if (heavyAt !== undefined && now - file.mtimeMs < QUIET_MS && now - heavyAt < MAX_HEAVY_DEFER_MS) {
      const quietAt = Math.min(file.mtimeMs + QUIET_MS, heavyAt + MAX_HEAVY_DEFER_MS)
      resyncAt.set(file.path, quietAt)
      return holdBack(quietAt)
    }
    const started = Date.now()
    let failed = false
    try {
      return await options.parse(file)
    } catch (error) {
      failed = true
      throw error
    } finally {
      const failureCount = failed ? (failures.get(file.path) ?? 0) + 1 : 0
      if (failed) failures.set(file.path, failureCount)
      else failures.delete(file.path)
      const finished = Date.now()
      if (finished - started >= HEAVY_READ_MS) heavyReadAt.set(file.path, finished)
      else heavyReadAt.delete(file.path)
      const cost = Math.max(MIN_RESYNC_MS, (finished - started) * COST_FACTOR) * 2 ** failureCount
      resyncAt.set(file.path, finished + Math.min(MAX_RESYNC_MS, cost))
    }
  }

  async function pass(): Promise<void> {
    const memory = openStore()
    if (!memory) return
    const passStarted = Date.now()
    heldBackUntil = Infinity
    const files = await options.listFiles()
    const titles = new Map<string, string | null>()
    await reconcileStore(memory, files, {
      parse: async (file) => {
        const session = await parseCooperatively(file)
        if (session && !file.isSubagent) titles.set(file.path, await options.title(file).catch(() => null))
        return session
      },
      title: (file) => titles.get(file.path),
      pause: options.pause ?? yieldToEventLoop,
    }, { signal: controller.signal })
    if (stopped) return
    pendingFiles = memory.planSync(files).length
    lastPassMs = Date.now() - passStarted
    lastPassEnd = Date.now()
    await embed(memory)
  }

  /** Read the embedding configuration again; a change replaces the embedder and cancels a run made for the old one. */
  async function refreshEmbedder(): Promise<void> {
    const config = await options.readEmbeddingConfig()
    if (config.stamp === configStamp) return
    configStamp = config.stamp
    outage = null
    configError = null
    try {
      embedder = options.createEmbedder(config.text)
    } catch (error) {
      embedder = null
      configError = error instanceof Error ? error.message : String(error)
      warn(`[memory] the embedding configuration is not usable: ${configError}`)
    }
    embedRun?.abort()
  }

  async function embed(memory: MemoryStore): Promise<void> {
    embedMoreSoon = false
    await refreshEmbedder()
    if (!embedder) {
      pendingEmbeddings = 0
      return
    }
    if (outage && Date.now() < outage.retryAt) return
    const run = embedRun = new AbortController()
    const result = await embedder.embedPending(memory, AbortSignal.any([controller.signal, run.signal]))
    embedRun = null
    if (run.signal.aborted) {
      // Cancelled for a new configuration, not a failure of the old endpoint: the next pass embeds with the new one.
      embedMoreSoon = !stopped
      return
    }
    pendingEmbeddings = result.remaining
    if (result.error) {
      if (!outage) warn(`[memory] the embedding endpoint is unavailable (${result.error}); retrying with back-off`)
      const failureCount = (outage?.failures ?? 0) + 1
      outage = { failures: failureCount, retryAt: Date.now() + Math.min(MAX_EMBED_RETRY_MS, EMBED_RETRY_MS * 2 ** (failureCount - 1)), error: result.error }
      return
    }
    outage = null
    // Texts the endpoint refuses stay pending; only a run that got somewhere hurries the next.
    embedMoreSoon = result.remaining > 0 && result.embedded > 0 && !stopped
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      scheduleAt(Date.now() + (options.startDelayMs ?? START_DELAY_MS))
    },
    hint() {
      if (stopped || unavailable) return
      if (running) {
        rerun = true
        return
      }
      // Before the first pass the start timer is already due.
      if (lastPassEnd) scheduleAt(Math.max(Date.now(), lastPassEnd + hintDelay()))
    },
    async reloadEmbeddings() {
      if (stopped || unavailable) return
      await refreshEmbedder()
      if (running) rerun = true
      else scheduleAt(Date.now())
    },
    async stop() {
      if (stopped) return
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
      timer = null
      await running
      store?.close()
      store = null
    },
    store: () => store,
    embedder: () => embedder,
    embeddingError: () => configError ?? outage?.error ?? null,
    counts: () => ({ pendingFiles, pendingEmbeddings }),
    async settled() {
      while (running) await running
    },
  }
}
