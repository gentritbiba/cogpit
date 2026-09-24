// ── Session access signals ───────────────────────────────
//
// What the server says about the caller's access to one session: the access
// header on a refused request and the `access` frame on a stream. Both name
// the session, and both become one of two window events. A session the
// caller deletes here leaves their reach too, which is no loss to report.

import {
  SESSION_ACCESS_EVENT,
  SESSION_ACCESS_HEADER,
  SESSION_ID_HEADER,
  type SessionAccessFrame,
} from "../../shared/contracts/sessionAccess"

/** Window event (`detail: { sessionId }`): the caller can no longer see the session. */
export const SESSION_ACCESS_LOST_EVENT = "cogpit-session-access-lost"
/** Window event (`detail: { sessionId }`): the server changed the caller's level on the session. */
export const SESSION_ACCESS_CHANGED_EVENT = "cogpit-session-access-changed"
/** Window event (`detail: { sessionId }`): the caller deleted the session here. */
export const SESSION_DELETED_EVENT = "cogpit-session-deleted"

/** How long the losses a delete causes keep arriving: its streams, their reconnects, requests in flight. */
const DELETE_ECHO_MS = 60_000

/** Each session the caller is deleting or just deleted here, by whether the delete happened. */
const deletions = new Map<string, Promise<boolean>>()

type AccessSignal = SessionAccessFrame["level"]

const SIGNALS: readonly string[] = ["none", "view", "interact", "own"] satisfies readonly AccessSignal[]

function isSignal(value: unknown): value is AccessSignal {
  return typeof value === "string" && SIGNALS.includes(value)
}

/** What each event says: the session, and whether a background request (see `authFetch`) learned it. */
interface AccessEventDetail {
  sessionId: string
  background: boolean
}

function dispatch(eventName: string, sessionId: string, background = false): void {
  window.dispatchEvent(new CustomEvent<AccessEventDetail>(eventName, { detail: { sessionId, background } }))
}

function announce(sessionId: string, level: AccessSignal, background = false): void {
  dispatch(level === "none" ? SESSION_ACCESS_LOST_EVENT : SESSION_ACCESS_CHANGED_EVENT, sessionId, background)
}

/** Whether the server refused a request on the caller's access to the session it names. */
export function isAccessRefusal(res: Response): boolean {
  return res.headers.has(SESSION_ACCESS_HEADER)
}

/** Whether the server refused a request because the caller cannot see what it asked about, whether or not it names the session. */
export function isLossRefusal(res: Response): boolean {
  return res.headers.get(SESSION_ACCESS_HEADER) === "none"
}

/** Announce what a refused session request says about the caller's access; any other response says nothing. */
export function announceRefusal(res: Response, background = false): void {
  const level = res.headers.get(SESSION_ACCESS_HEADER)
  const sessionId = res.headers.get(SESSION_ID_HEADER)
  if (isSignal(level) && sessionId) announce(sessionId, level, background)
}

/** Announce the `access` frames a stream carries about its session. Returns the stop. */
export function announceAccessFrames(source: EventSource): () => void {
  function handle(event: Event): void {
    let frame: Partial<SessionAccessFrame>
    try {
      frame = JSON.parse((event as MessageEvent<string>).data) as Partial<SessionAccessFrame>
    } catch {
      return
    }
    if (isSignal(frame.level) && typeof frame.sessionId === "string") announce(frame.sessionId, frame.level)
  }
  source.addEventListener(SESSION_ACCESS_EVENT, handle)
  return () => source.removeEventListener(SESSION_ACCESS_EVENT, handle)
}

function listen(eventName: string, listener: (sessionId: string, background: boolean) => void, only?: string): () => void {
  function handle(event: Event): void {
    const detail = (event as CustomEvent<Partial<AccessEventDetail> | undefined>).detail
    const sessionId = detail?.sessionId
    if (typeof sessionId !== "string" || (only !== undefined && sessionId !== only)) return
    listener(sessionId, detail?.background === true)
  }
  window.addEventListener(eventName, handle)
  return () => window.removeEventListener(eventName, handle)
}

/**
 * Calls `listener` with each session the caller loses access to, and whether
 * only a background request learned it; returns the unsubscribe.
 */
export function onSessionAccessLost(listener: (sessionId: string, background: boolean) => void): () => void {
  return listen(SESSION_ACCESS_LOST_EVENT, listener)
}

/**
 * Track the caller deleting a session here; `deleting` resolves whether it
 * was deleted, and so does the returned promise. The delete takes the
 * caller's access too, and the session's stream can say so before the
 * delete's own answer arrives, so a loss of the session waits on the delete
 * (see {@link deletedHere}). A delete that happened is announced.
 */
export function trackDeletion(sessionId: string, deleting: Promise<boolean>): Promise<boolean> {
  const deleted = deleting.catch(() => false)
  deletions.set(sessionId, deleted)
  const forget = () => {
    if (deletions.get(sessionId) === deleted) deletions.delete(sessionId)
  }
  return deleted.then((happened) => {
    if (happened) {
      dispatch(SESSION_DELETED_EVENT, sessionId)
      setTimeout(forget, DELETE_ECHO_MS)
    } else {
      forget()
    }
    return happened
  })
}

/** Resolves whether the caller deleted the session here, just now or with a delete still under way. */
export function deletedHere(sessionId: string): Promise<boolean> {
  return deletions.get(sessionId) ?? Promise.resolve(false)
}

/** Calls `listener` with each session the caller deletes here; returns the unsubscribe. */
export function onSessionDeleted(listener: (sessionId: string) => void): () => void {
  return listen(SESSION_DELETED_EVENT, listener)
}

/**
 * Calls `listener` with each session whose level the server changed, or only
 * when it names `sessionId`; returns the unsubscribe.
 */
export function onSessionAccessChanged(listener: (sessionId: string) => void, sessionId?: string): () => void {
  return listen(SESSION_ACCESS_CHANGED_EVENT, listener, sessionId)
}
