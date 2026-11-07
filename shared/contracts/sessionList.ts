// ── Session list push and revalidation ──────────────────────────────────
//
// `/api/session-list/events` streams the list version; `/api/active-sessions`
// and `/api/projects` answer `If-None-Match` with 304 while their body for the
// caller is unchanged. A server without the stream answers it with 404.

export const SESSION_LIST_EVENTS_PATH = "/api/session-list/events"
export const SESSION_LIST_VERSION_EVENT = "version"
export const SESSION_LIST_VERSION_HEADER = "X-Cogpit-List-Version"

export interface SessionListVersionEvent {
  version: number
}

export function parseSessionListVersion(data: unknown): number | null {
  if (typeof data !== "string") return null
  try {
    const parsed = JSON.parse(data) as Partial<SessionListVersionEvent> | null
    return typeof parsed?.version === "number" && Number.isFinite(parsed.version) ? parsed.version : null
  } catch {
    return null
  }
}
