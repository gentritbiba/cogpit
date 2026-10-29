import { parseSession, parseSessionAppend } from "../../shared/session/parser"
import { liftElidedResults } from "../../shared/session/resultProjection"
import type { ParsedSession } from "../../shared/session/types"

/**
 * `keep` names the version under which this worker keeps the session it
 * answers with, so the next append to it sends only the new text instead of a
 * copy of the whole session. An append naming a version the worker no longer
 * holds (it restarted, let the session go, or a later append replaced it) is
 * answered `missing`, and the caller resends it whole.
 */
export interface KeptVersion { handle: number; version: number }

export type WorkerRequest =
  | { type: "parse"; id: number; text: string }
  | { type: "append"; id: number; existing: ParsedSession; newText: string; keep?: KeptVersion }
  | { type: "append"; id: number; base: KeptVersion; newText: string; keep?: KeptVersion }

export type WorkerResponse =
  | { type: "result"; id: number; session: ParsedSession }
  | { type: "missing"; id: number }
  | { type: "error"; id: number; error: string }

/** Sessions kept for appends; the oldest goes first. */
const KEPT_SESSIONS = 4
const kept = new Map<number, { version: number; session: ParsedSession }>()

function keep(version: KeptVersion | undefined, session: ParsedSession): void {
  if (!version) return
  kept.delete(version.handle)
  kept.set(version.handle, { version: version.version, session })
  while (kept.size > KEPT_SESSIONS) kept.delete(kept.keys().next().value!)
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    let session: ParsedSession
    if (msg.type === "parse") {
      session = parseSession(msg.text)
    } else {
      let existing: ParsedSession | undefined
      if ("base" in msg) {
        const held = kept.get(msg.base.handle)
        if (held?.version === msg.base.version) {
          existing = held.session
          // Appending may change the kept session in place; it is only ever used once.
          kept.delete(msg.base.handle)
        }
      } else existing = msg.existing
      if (!existing) {
        self.postMessage({ type: "missing", id: msg.id } satisfies WorkerResponse)
        return
      }
      session = parseSessionAppend(existing, msg.newText)
      keep(msg.keep, session)
    }
    liftElidedResults(session)
    self.postMessage({ type: "result", id: msg.id, session } satisfies WorkerResponse)
  } catch (err) {
    self.postMessage({
      type: "error",
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse)
  }
}
