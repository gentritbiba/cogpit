import { appendSessionInPlace, parseSession } from "../../shared/session/parser"
import { liftElidedTurn } from "../../shared/session/resultProjection"
import { computeSessionDigest, toSessionView, type SessionDigest, type SessionView } from "../../shared/session/sessionDigest"
import type { ParsedSession, SessionStats, Turn } from "../../shared/session/types"
import { jsonEqual } from "../lib/jsonEqual"

/**
 * The worker keeps the sessions it parsed, raw records included, and the
 * renderer holds only a `SessionView` of each. `KeptVersion` names one: an
 * append to it answers with what changed, and the kept session moves on to the
 * next version. The renderer decides how long a session is kept and releases
 * it when it holds no view of it any more. An append naming a version the
 * worker no longer holds (it restarted, the session was released, or another
 * append moved it on) is answered `missing`, and the renderer loads the session
 * again.
 */
export interface KeptVersion { handle: number; version: number }

/** Everything in a view but its turns, stats and digest. */
export type SessionMeta = Omit<SessionView, "turns" | "stats" | "digest">

/**
 * The turns from `fromTurn` on, which replace the ones from there in the view
 * the append was made to; the turns before `fromTurn` did not change. A turn's
 * version changes whenever the turn does.
 */
export interface SessionDelta {
  fromTurn: number
  turns: Turn[]
  turnVersions: number[]
  stats: SessionStats
  digest: SessionDigest
  meta: SessionMeta
}

export type WorkerRequest =
  | { type: "parse"; id: number; text: string; keep: boolean }
  | { type: "append"; id: number; base: KeptVersion; newText: string }
  | { type: "release"; handle: number }

export type WorkerResponse =
  | { type: "parsed"; id: number; view: SessionView; turnVersions: number[]; kept: KeptVersion | null }
  | { type: "delta"; id: number; delta: SessionDelta; kept: KeptVersion }
  | { type: "missing"; id: number }
  | { type: "error"; id: number; error: string }

interface Held {
  version: number
  session: ParsedSession
  turnVersions: number[]
  digest: SessionDigest
  /** Records the digest has already looked at. */
  scannedTo: number
}

const kept = new Map<number, Held>()
let nextHandle = 0
let lastStamp = 0
const stamp = () => ++lastStamp

function metaOf(session: ParsedSession): SessionMeta {
  const { turns: _turns, stats: _stats, rawMessages: _records, ...meta } = session
  return meta
}

function parse(text: string, keep: boolean): WorkerResponse & { type: "parsed" } {
  const session = parseSession(text)
  for (const turn of session.turns) liftElidedTurn(turn)
  const digest = computeSessionDigest(session.rawMessages)
  const turnVersions = session.turns.map(stamp)
  let keptVersion: KeptVersion | null = null
  if (keep) {
    keptVersion = { handle: nextHandle++, version: 1 }
    kept.set(keptVersion.handle, { version: 1, session, turnVersions, digest, scannedTo: session.rawMessages.length })
  }
  return { type: "parsed", id: 0, view: toSessionView(session, digest), turnVersions, kept: keptVersion }
}

/**
 * Appends to a kept session. Turns the append left alone are the same objects;
 * a rebuilt turn that came out equal to the one it replaces is swapped back for
 * it, so only turns that really changed get a new version.
 */
function append(base: KeptVersion, newText: string): (WorkerResponse & { type: "delta" }) | null {
  const held = kept.get(base.handle)
  if (!held || held.version !== base.version) return null
  const before = held.session.turns
  const scannedTo = held.session.rawMessages.length
  const session = appendSessionInPlace(held.session, newText)
  const turns = session.turns
  const turnVersions: number[] = []
  let fromTurn = turns.length
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index]!
    const previous = before[index]
    if (turn === previous) {
      turnVersions.push(held.turnVersions[index]!)
      continue
    }
    liftElidedTurn(turn)
    if (previous && previous.id === turn.id && jsonEqual(previous, turn)) {
      turns[index] = previous
      turnVersions.push(held.turnVersions[index]!)
      continue
    }
    turnVersions.push(stamp())
    fromTurn = Math.min(fromTurn, index)
  }
  if (turns.length < before.length) fromTurn = Math.min(fromTurn, turns.length)

  const digest = computeSessionDigest(session.rawMessages, { digest: held.digest, scannedTo })
  const version = held.version + 1
  kept.set(base.handle, { version, session, turnVersions, digest, scannedTo: session.rawMessages.length })
  return {
    type: "delta",
    id: 0,
    kept: { handle: base.handle, version },
    delta: {
      fromTurn,
      turns: turns.slice(fromTurn),
      turnVersions: turnVersions.slice(fromTurn),
      stats: session.stats,
      digest,
      meta: metaOf(session),
    },
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  if (msg.type === "release") {
    kept.delete(msg.handle)
    return
  }
  try {
    const response: WorkerResponse = msg.type === "parse"
      ? parse(msg.text, msg.keep)
      : append(msg.base, msg.newText) ?? { type: "missing", id: msg.id }
    self.postMessage({ ...response, id: msg.id } satisfies WorkerResponse)
  } catch (err) {
    // A failed append may have left the kept session half-extended.
    if (msg.type === "append") kept.delete(msg.base.handle)
    self.postMessage({
      type: "error",
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies WorkerResponse)
  }
}
