import { SESSION_ARCHIVE_FILE } from "./sessionConfigDir"
import { SessionConfigFile } from "./sessionConfigFile"

/**
 * Which sessions the sidebar hides. Stored on the Cogpit server so every
 * client and device sees the same list.
 *
 * A session is archived when the user archived it (`archived`, keyed by
 * session id with the archive time) or when its transcript has been idle for
 * {@link AUTO_ARCHIVE_AFTER_MS}. Restoring a session lists it in `kept`, which
 * exempts it from the idle rule. New activity overrides a manual archive: see
 * {@link isStillArchived}.
 */

/**
 * Transcript writes this soon after archiving are trailing writes of the turn
 * that just ended (title generation, usage lines), not a resumed session.
 */
export const REACTIVATION_GRACE_MS = 2 * 60_000

/** Idle this long, a session is archived without anyone asking. */
export const AUTO_ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60_000

export type ArchiveReason = "manual" | "inactive"

export interface ArchiveSnapshot {
  /** Session id → epoch ms of the user's archive action. */
  archived: ReadonlyMap<string, number>
  /** Sessions the user restored, exempt from the idle rule. */
  kept: ReadonlySet<string>
}

interface PersistedArchive {
  version: 2
  sessions: Record<string, number>
  kept: string[]
}

let archived = new Map<string, number>()
let kept = new Set<string>()

const file = new SessionConfigFile(SESSION_ARCHIVE_FILE, {
  reset() {
    archived = new Map()
    kept = new Set()
  },
  apply(parsed) {
    if (typeof parsed !== "object" || parsed === null) return
    const candidate = parsed as Partial<PersistedArchive>
    if (typeof candidate.sessions === "object" && candidate.sessions) {
      for (const [sessionId, archivedAt] of Object.entries(candidate.sessions)) {
        if (typeof archivedAt === "number" && Number.isFinite(archivedAt)) archived.set(sessionId, archivedAt)
      }
    }
    if (Array.isArray(candidate.kept)) {
      for (const sessionId of candidate.kept) {
        if (typeof sessionId === "string" && sessionId) kept.add(sessionId)
      }
    }
  },
  snapshot(): PersistedArchive {
    return { version: 2, sessions: Object.fromEntries(archived), kept: [...kept] }
  },
})

export async function readArchive(): Promise<ArchiveSnapshot> {
  await file.load()
  return { archived: new Map(archived), kept: new Set(kept) }
}

/**
 * Archive or restore sessions. Returns the ids whose state changed; nothing is
 * written for a no-op. Restoring also marks the session kept so the idle rule
 * does not archive it again.
 */
export async function setSessionsArchived(
  sessionIds: readonly string[],
  archive: boolean,
  now = Date.now(),
): Promise<string[]> {
  await file.load()
  const changed: string[] = []
  for (const sessionId of sessionIds) {
    const wasArchived = archived.has(sessionId)
    const wasKept = kept.has(sessionId)
    if (archive) {
      archived.set(sessionId, archived.get(sessionId) ?? now)
      kept.delete(sessionId)
      if (!wasArchived || wasKept) changed.push(sessionId)
    } else {
      archived.delete(sessionId)
      kept.add(sessionId)
      if (wasArchived || !wasKept) changed.push(sessionId)
    }
  }
  if (changed.length > 0) await file.persist()
  return changed
}

/** Drop every record of sessions that no longer exist. */
export async function forgetSessions(sessionIds: readonly string[]): Promise<void> {
  await file.load()
  let changed = false
  for (const sessionId of sessionIds) {
    if (archived.delete(sessionId)) changed = true
    if (kept.delete(sessionId)) changed = true
  }
  if (changed) await file.persist()
}

/**
 * Whether a manual archive still holds for a transcript last written at
 * `mtimeMs`. Activity well after archiving means the session was resumed, and
 * a resumed session belongs back in the sidebar.
 */
export function isStillArchived(archivedAt: number | undefined, mtimeMs: number): boolean {
  return archivedAt !== undefined && mtimeMs <= archivedAt + REACTIVATION_GRACE_MS
}

/** Why a session is archived right now, or null when it is listed. */
export function archiveReason(
  snapshot: ArchiveSnapshot,
  sessionId: string,
  mtimeMs: number,
  now = Date.now(),
): ArchiveReason | null {
  if (isStillArchived(snapshot.archived.get(sessionId), mtimeMs)) return "manual"
  if (!snapshot.kept.has(sessionId) && now - mtimeMs > AUTO_ARCHIVE_AFTER_MS) return "inactive"
  return null
}

export function __resetSessionArchiveForTest(): void {
  file.resetForTest()
}
