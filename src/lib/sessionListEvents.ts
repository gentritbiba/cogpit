// ── Session list push ───────────────────────────────────────────────────
//
// One `/api/session-list/events` stream per device and signed-in user, shared
// by everything that lists sessions or projects. It carries only the list
// version; each subscriber revalidates its own list with `If-None-Match`.

import { authFetch } from "@/lib/auth"
import { getActiveDeviceScope, getActiveIdentity, withBase } from "@/lib/device"
import {
  SESSION_LIST_EVENTS_PATH,
  SESSION_LIST_VERSION_EVENT,
  parseSessionListVersion,
  type SessionListVersionEvent,
} from "../../shared/contracts/sessionList"

export interface SessionListEventHandlers {
  onVersion: (event: SessionListVersionEvent) => void
  /** No list stream for this caller (an older hub device, or a server that refuses it): the caller polls. */
  onUnsupported: () => void
  /** The stream a server refused came back: the caller stops polling. */
  onSupported: () => void
}

const MAX_RETRY_MS = 30_000
/** A server that refuses the stream is asked again this often; access or sign-in may have changed. */
export const REFUSED_RETRY_MS = 5 * 60_000
const REFUSED = new Set([401, 403])
const owners = new Map<string, ListEventsOwner>()

/** `missing`: the server has no stream. `refused`: it keeps it from this caller for now. */
type Availability = "available" | "missing" | "refused"

class ListEventsOwner {
  private source: EventSource | null = null
  private readonly handlers = new Set<SessionListEventHandlers>()
  private availability: Availability = "available"
  private stopped = false
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private probe: AbortController | null = null

  constructor(private readonly key: string, private readonly url: string) {
    if (typeof EventSource === "undefined") this.availability = "missing"
    else this.connect()
  }

  add(handlers: SessionListEventHandlers): void {
    this.handlers.add(handlers)
    if (this.availability === "available") return
    queueMicrotask(() => {
      if (this.handlers.has(handlers)) handlers.onUnsupported()
    })
    // A new subscriber comes after a sign-in or a scope change: the refusal may be over.
    if (this.availability === "refused") this.retry(0)
  }

  remove(handlers: SessionListEventHandlers): void {
    this.handlers.delete(handlers)
    if (this.handlers.size === 0) this.close()
  }

  private connect(): void {
    if (this.stopped) return
    this.source?.close()
    const source = new EventSource(this.url)
    this.source = source
    source.addEventListener("open", () => {
      this.attempts = 0
      if (source !== this.source || this.availability !== "refused") return
      this.availability = "available"
      for (const handlers of [...this.handlers]) handlers.onSupported()
    })
    source.addEventListener(SESSION_LIST_VERSION_EVENT, (event) => {
      const parsed = parseSessionListVersion((event as MessageEvent).data)
      if (parsed === null || source !== this.source) return
      for (const handlers of [...this.handlers]) handlers.onVersion(parsed)
    })
    source.addEventListener("error", () => {
      // While CONNECTING the browser reconnects on its own; CLOSED means it gave up.
      if (source !== this.source || source.readyState !== EventSource.CLOSED) return
      void this.recover(source)
    })
  }

  private retry(delay: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.connect(), delay)
  }

  private async recover(source: EventSource): Promise<void> {
    const probe = new AbortController()
    this.probe = probe
    let outcome: Availability = "available"
    try {
      const response = await authFetch(this.url, { signal: probe.signal })
      void response.body?.cancel()
      if (REFUSED.has(response.status)) outcome = "refused"
      else if (response.status === 404 || (response.ok && !response.headers.get("content-type")?.includes("text/event-stream"))) {
        outcome = "missing"
      }
    } catch {
      // Offline: retry below.
    }
    if (this.stopped || source !== this.source || probe.signal.aborted) return
    if (outcome === "available") {
      this.retry(Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(this.attempts++, 5)))
      return
    }
    source.close()
    this.source = null
    const wasAvailable = this.availability === "available"
    this.availability = outcome
    if (wasAvailable) for (const handlers of [...this.handlers]) handlers.onUnsupported()
    if (outcome === "refused") this.retry(REFUSED_RETRY_MS)
  }

  close(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.probe?.abort()
    this.source?.close()
    this.source = null
    if (owners.get(this.key) === this) owners.delete(this.key)
  }
}

/** Follow the list version on the active device; returns the unsubscribe. */
export function subscribeSessionListEvents(handlers: SessionListEventHandlers): () => void {
  const url = withBase(SESSION_LIST_EVENTS_PATH)
  const key = JSON.stringify([getActiveDeviceScope(), getActiveIdentity(), url])
  let owner = owners.get(key)
  if (!owner) {
    owner = new ListEventsOwner(key, url)
    owners.set(key, owner)
  }
  const subscribed = owner
  subscribed.add(handlers)
  return () => subscribed.remove(handlers)
}

export function __resetSessionListEventsForTest(): void {
  for (const owner of [...owners.values()]) owner.close()
  owners.clear()
}
