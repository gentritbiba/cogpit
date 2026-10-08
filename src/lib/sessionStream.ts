import { authFetch, authUrl } from "@/lib/auth"
import { getActiveDeviceScope, getActiveIdentity } from "@/lib/device"
import { announceAccessFrames, isLossRefusal } from "@/lib/sessionAccessEvents"
import { announceConfigFrames } from "@/lib/sessionConfigEvents"

export interface ConnectionState {
  transport: "connecting" | "open" | "retrying" | "denied" | "closed"
  freshness: "waiting" | "current" | "stale"
  lastEventAt: number | null
}
export interface SessionStream { source: EventSource; close: () => void; state: () => ConnectionState }
interface SessionStreamOptions { onLost?: () => void; onState?: (state: ConnectionState) => void }

const owners = new Map<string, StreamOwner>()

class Subscriber extends EventTarget {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSED = 2
  readonly withCredentials = false
  onopen: EventSource["onopen"] = null
  onmessage: EventSource["onmessage"] = null
  onerror: EventSource["onerror"] = null
  constructor(readonly owner: StreamOwner, readonly options: SessionStreamOptions) {
    super()
    for (const type of ["open", "message", "error"]) super.addEventListener(type, (event) => {
      const handler = type === "open" ? this.onopen : type === "message" ? this.onmessage : this.onerror
      handler?.call(this as unknown as EventSource, event as MessageEvent)
    })
  }
  get url(): string { return this.owner.url }
  get readyState(): number { return this.owner.source?.readyState ?? (this.owner.health.transport === "denied" ? 2 : 0) }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    this.owner.listen(type)
    super.addEventListener(type, listener, options)
  }
  close(): void { this.owner.remove(this) }
  emit(event: Event): void {
    this.dispatchEvent(event instanceof MessageEvent ? new MessageEvent(event.type, { data: event.data, origin: event.origin, lastEventId: event.lastEventId }) : new Event(event.type))
  }
}

class StreamOwner {
  source: EventSource | null = null
  health: ConnectionState = { transport: "connecting", freshness: "waiting", lastEventAt: null }
  private readonly subscribers = new Set<Subscriber>()
  private readonly types = new Set(["open", "error", "message", "access", "session-config"])
  private readonly linked = new Set<string>()
  private asking: AbortController | null = null
  private timer?: ReturnType<typeof setTimeout>
  private attempts = 0
  private generation = 0
  private retryingGeneration: number | null = null
  private stopped = false
  private stopFrames: (() => void)[] = []
  private readonly foreground = () => {
    if (document.visibilityState === "hidden" || this.stopped || this.health.transport === "denied") return
    if (!this.source || this.health.transport !== "open" || (this.health.lastEventAt !== null && Date.now() - this.health.lastEventAt > 45000)) this.connect()
  }
  private readonly identityChanged = () => this.stop()

  constructor(readonly key: string, readonly url: string) {
    window.addEventListener("online", this.foreground)
    document.addEventListener("visibilitychange", this.foreground)
    window.addEventListener("cogpit-identity-changed", this.identityChanged)
    window.addEventListener("cogpit-device-scope-changed", this.identityChanged)
    this.connect()
  }
  add(options: SessionStreamOptions): Subscriber {
    const subscriber = new Subscriber(this, options)
    this.subscribers.add(subscriber)
    queueMicrotask(() => {
      if (!this.subscribers.has(subscriber)) return
      options.onState?.(this.health)
      if (this.health.transport === "open") subscriber.emit(new Event("open"))
      else if (this.health.transport === "denied") options.onLost?.()
    })
    return subscriber
  }
  remove(subscriber: Subscriber): void { this.subscribers.delete(subscriber); if (!this.subscribers.size) this.stop() }
  listen(type: string): void { this.types.add(type); this.link(type) }
  private link(type: string): void {
    const source = this.source
    const generation = this.generation
    if (!source || this.linked.has(type)) return
    this.linked.add(type)
    source.addEventListener(type, (event) => {
      if (this.stopped || generation !== this.generation) return
      if (type === "open") { this.attempts = 0; this.setHealth({ ...this.health, transport: "open" }) }
      else if (type === "error") {
        if (this.retryingGeneration === generation) return
        this.retryingGeneration = generation
        this.setHealth({ ...this.health, transport: "retrying", freshness: "stale" })
        const closed = source.readyState === EventSource.CLOSED
        source.close()
        void this.retry(generation, closed)
      } else this.setHealth({ transport: "open", freshness: "current", lastEventAt: Date.now() })
      for (const subscriber of this.subscribers) subscriber.emit(event)
    })
  }
  private setHealth(state: ConnectionState): void { this.health = state; for (const subscriber of this.subscribers) subscriber.options.onState?.(state) }
  private connect(): void {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.asking?.abort()
    for (const stop of this.stopFrames) stop()
    this.source?.close()
    this.generation++
    this.retryingGeneration = null
    this.linked.clear()
    this.setHealth({ ...this.health, transport: "connecting" })
    this.source = new EventSource(this.url)
    this.stopFrames = [announceAccessFrames(this.source), announceConfigFrames(this.source)]
    for (const type of this.types) this.link(type)
  }
  private async retry(generation: number, closed: boolean): Promise<void> {
    const asking = new AbortController()
    this.asking = asking
    if (closed) {
      try {
        // Capture the environment URL: navigation must not check another host.
        const response = await authFetch(this.url, { signal: asking.signal })
        void response.body?.cancel()
        if (this.stopped || generation !== this.generation || asking.signal.aborted) return
        if (response.status === 401 || response.status === 403 || isLossRefusal(response)) {
          this.setHealth({ ...this.health, transport: "denied", freshness: "stale" })
          for (const subscriber of this.subscribers) subscriber.options.onLost?.()
          return
        }
      } catch { if (this.stopped || asking.signal.aborted) return }
    }
    if (this.stopped || generation !== this.generation) return
    const delay = Math.min(30000, 500 * 2 ** Math.min(this.attempts++, 6)) * (0.75 + Math.random() * 0.5)
    this.timer = setTimeout(() => this.connect(), delay)
  }
  stop(): void {
    this.stopped = true; this.generation++
    clearTimeout(this.timer); this.asking?.abort(); this.source?.close()
    for (const stop of this.stopFrames) stop()
    window.removeEventListener("online", this.foreground)
    document.removeEventListener("visibilitychange", this.foreground)
    window.removeEventListener("cogpit-identity-changed", this.identityChanged)
    window.removeEventListener("cogpit-device-scope-changed", this.identityChanged)
    this.setHealth({ ...this.health, transport: "closed", freshness: "stale" })
    if (owners.get(this.key) === this) owners.delete(this.key)
  }
}

export function openSessionStream(url: string, options: SessionStreamOptions = {}): SessionStream {
  const resolved = authUrl(url)
  const key = JSON.stringify([getActiveDeviceScope(), getActiveIdentity(), resolved])
  let owner = owners.get(key)
  if (!owner) { owner = new StreamOwner(key, resolved); owners.set(key, owner) }
  const source = owner.add(options)
  return { source: source as unknown as EventSource, close: () => source.close(), state: () => owner.health }
}
export function __resetStreamsForTest(): void { for (const owner of owners.values()) owner.stop(); owners.clear() }
