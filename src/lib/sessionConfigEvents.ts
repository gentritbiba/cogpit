// ── Session config signals ─────────────────────────────────────────────
//
// A session's stream names the session in a `session-config` frame whenever
// its stored composer config changes, whoever changed it. Each frame becomes a
// window event, on which the open session reads its config again.

import { SESSION_CONFIG_EVENT } from "../../shared/contracts/sessionAccess"

/** Window event (`detail: { sessionId }`): the session's stored config changed. */
export const SESSION_CONFIG_CHANGED_EVENT = "cogpit-session-config-changed"

/** The session a frame names: its JSON `{ sessionId }`, or the bare id. */
function frameSessionId(data: unknown): string | null {
  if (typeof data !== "string") return null
  let frame: unknown
  try {
    frame = JSON.parse(data)
  } catch {
    frame = data.trim()
  }
  if (typeof frame === "string") return frame || null
  const sessionId = (frame as { sessionId?: unknown } | null)?.sessionId
  return typeof sessionId === "string" ? sessionId : null
}

/** Announce the `session-config` frames a stream carries. Returns the stop. */
export function announceConfigFrames(source: EventSource): () => void {
  function handle(event: Event): void {
    const sessionId = frameSessionId((event as MessageEvent<unknown>).data)
    if (!sessionId) return
    window.dispatchEvent(new CustomEvent(SESSION_CONFIG_CHANGED_EVENT, { detail: { sessionId } }))
  }
  source.addEventListener(SESSION_CONFIG_EVENT, handle)
  return () => source.removeEventListener(SESSION_CONFIG_EVENT, handle)
}

/** Calls `listener` each time the stored config of `sessionId` changed; returns the unsubscribe. */
export function onSessionConfigChanged(sessionId: string, listener: () => void): () => void {
  function handle(event: Event): void {
    if ((event as CustomEvent<{ sessionId?: unknown } | undefined>).detail?.sessionId === sessionId) listener()
  }
  window.addEventListener(SESSION_CONFIG_CHANGED_EVENT, handle)
  return () => window.removeEventListener(SESSION_CONFIG_CHANGED_EVENT, handle)
}
