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
} from "../../shared/contracts/sessionList"

export interface SessionListEventHandlers {
  onVersion: (version: number) => void
  /** The server has no list stream (an older hub device), so the caller polls. */
  onUnsupported: () => void
}

const MAX_RETRY_MS = 30_000
const owners = new Map<string, ListEventsOwner>()

class ListEventsOwner {
  private source: EventSource | null = null
  private readonly handlers = new Set<SessionListEventHandlers>()
  private unsupported = false
  private stopped = false
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private probe: AbortController | null = null

  constructor(private readonly key: string, private readonly url: string) {
    if (typeof EventSource === "undefined") this.unsupported = true
    else this.connect()
  }

  add(handlers: SessionListEventHandlers): void {
    this.handlers.add(handlers)
    if (!this.unsupported) return
    queueMicrotask(() => {
      if (this.handlers.has(handlers)) handlers.onUnsupported()
    })
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
    source.addEventListener("open", () => { this.attempts = 0 })
    source.addEventListener(SESSION_LIST_VERSION_EVENT, (event) => {
      const version = parseSessionListVersion((event as MessageEvent).data)
      if (version === null || source !== this.source) return
      for (const handlers of [...this.handlers]) handlers.onVersion(version)
    })
    source.addEventListener("error", () => {
      // While CONNECTING the browser reconnects on its own; CLOSED means it gave up.
      if (source !== this.source || source.readyState !== EventSource.CLOSED) return
      void this.recover(source)
    })
  }

  private async recover(source: EventSource): Promise<void> {
    const probe = new AbortController()
    this.probe = probe
    let missing = false
    try {
      const response = await authFetch(this.url, { signal: probe.signal })
      void response.body?.cancel()
      missing = response.status === 404
        || (response.ok && !response.headers.get("content-type")?.includes("text/event-stream"))
    } catch {
      // Offline or refused: retry below.
    }
    if (this.stopped || source !== this.source || probe.signal.aborted) return
    if (missing) {
      this.unsupported = true
      source.close()
      this.source = null
      for (const handlers of [...this.handlers]) handlers.onUnsupported()
      return
    }
    const delay = Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(this.attempts++, 5))
    this.timer = setTimeout(() => this.connect(), delay)
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
