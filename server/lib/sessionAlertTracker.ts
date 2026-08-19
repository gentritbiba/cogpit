import type { SessionStatus } from "../../shared/session/sessionStatus"

/**
 * One session as seen by a monitor sweep. `status` comes from the transcript
 * tail (deriveSessionStatus); `isActiveTurn` is the authoritative live signal
 * for server-driven Codex turns, which the tail lags behind.
 */
export interface TrackedSessionSnapshot {
  sessionId: string
  status: SessionStatus | null
  isActiveTurn?: boolean
  /** Teammates report through their lead, mirroring classifyAttention. */
  isTeammate?: boolean
}

export type SessionAlertReason = "turnComplete" | "permission"

export interface SessionAlert<T extends TrackedSessionSnapshot> {
  session: T
  reason: SessionAlertReason
}

/** Still mid-turn. Unrecognised/absent status counts as working so a status
 * this build has never heard of cannot fake a completion. */
function isWorking(session: TrackedSessionSnapshot): boolean {
  if (session.isActiveTurn) return true
  const { status } = session
  if (status === null) return true
  switch (status) {
    case "thinking":
    case "tool_use":
    case "processing":
    case "compacting":
      return true
    case "awaiting_agents":
      // The turn ended but background agents are still running — their
      // notification will start another turn, so the user is not needed yet.
      return true
    case "idle":
    case "completed":
    case "deferred":
      return false
    default:
      return true
  }
}

/** A positive terminal signal — the absence of a status must never read as a
 * finished turn. */
function isFinished(session: TrackedSessionSnapshot): boolean {
  if (session.isActiveTurn) return false
  return session.status === "completed" || session.status === "idle"
}

/**
 * Turns successive session snapshots into one-shot alerts.
 *
 * Direct port of the iOS SessionAlertTracker: clock-free and I/O-free on
 * purpose. Liveness heuristics that need a `now` can mark a *crashed* session
 * as finished, which would announce a turn that never completed. Working only
 * from the running→stopped edge costs a missed alert on a wedged session and
 * never invents one.
 */
export class SessionAlertTracker {
  private running = new Set<string>()
  private announced = new Set<string>()
  private seededRunningState = false

  /** Alerts earned since the previous snapshot. */
  alerts<T extends TrackedSessionSnapshot>(sessions: T[]): SessionAlert<T>[] {
    const nowRunning = new Set<string>()
    const alerts: SessionAlert<T>[] = []

    for (const session of sessions) {
      if (session.isTeammate) continue
      const id = session.sessionId
      const isBlocked = session.status === "deferred"

      if (isWorking(session) && !isBlocked) {
        nowRunning.add(id)
        // Working again: allow the next completion to announce itself.
        this.announced.delete(key(id, "turnComplete"))
      }

      if (isBlocked) {
        if (this.insertIfNew(id, "permission")) {
          alerts.push({ session, reason: "permission" })
        }
      } else {
        this.announced.delete(key(id, "permission"))
      }

      // Only a session this tracker watched working can complete. Without that
      // guard the first sweep would announce every idle session in the list.
      const finished = this.seededRunningState && this.running.has(id) && isFinished(session)
      if (finished && !isBlocked && this.insertIfNew(id, "turnComplete")) {
        alerts.push({ session, reason: "turnComplete" })
      }
    }

    // A session that dropped out of the sweep cannot be reasoned about, so
    // forget it instead of holding its state forever.
    const present = new Set(sessions.map((s) => s.sessionId))
    for (const announcedKey of this.announced) {
      if (!present.has(sessionIdFromKey(announcedKey))) this.announced.delete(announcedKey)
    }

    this.running = nowRunning
    this.seededRunningState = true
    return alerts
  }

  private insertIfNew(id: string, reason: SessionAlertReason): boolean {
    const k = key(id, reason)
    if (this.announced.has(k)) return false
    this.announced.add(k)
    return true
  }
}

function key(sessionId: string, reason: SessionAlertReason): string {
  return `${sessionId}:${reason}`
}

/** Inverse of `key` — reasons never contain ":", so the last one splits it. */
function sessionIdFromKey(announcedKey: string): string {
  return announcedKey.slice(0, announcedKey.lastIndexOf(":"))
}
