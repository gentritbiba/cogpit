// ── Session list push and revalidation ──────────────────────────────────
//
// `/api/session-list/events` streams the list version; `/api/active-sessions`
// and `/api/projects` answer `If-None-Match` with 304 while their body for the
// caller is unchanged. A server without the stream answers it with 404.
//
// Versions count up within one server run. Each run has its own `epoch`, so a
// client that sees a new epoch (or, from a server that sends none, a version
// going down) starts counting again instead of waiting for the old numbers.

export const SESSION_LIST_EVENTS_PATH = "/api/session-list/events"
export const SESSION_LIST_VERSION_EVENT = "version"
export const SESSION_LIST_VERSION_HEADER = "X-Cogpit-List-Version"
export const SESSION_LIST_EPOCH_HEADER = "X-Cogpit-List-Epoch"

export interface SessionListVersionEvent {
  version: number
  /** The server run the version counts in; absent from servers that predate it. */
  epoch?: string
}

export function parseSessionListVersion(data: unknown): SessionListVersionEvent | null {
  if (typeof data !== "string") return null
  try {
    const parsed = JSON.parse(data) as Partial<SessionListVersionEvent> | null
    if (typeof parsed?.version !== "number" || !Number.isFinite(parsed.version)) return null
    return typeof parsed.epoch === "string" ? { version: parsed.version, epoch: parsed.epoch } : { version: parsed.version }
  } catch {
    return null
  }
}
