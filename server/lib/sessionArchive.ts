import type { ArchiveMark } from "../agents/types"
import { SESSION_ARCHIVE_FILE } from "./sessionConfigDir"
import { SessionConfigFile } from "./sessionConfigFile"

/**
 * Which sessions the sidebar hides. Stored on the Cogpit server so every
 * client and device sees the same list.
 *
 * A session is archived when the user archived it (`archived`, keyed by
 * session id with the archive time) or when its transcript has been idle for
 * {@link AUTO_ARCHIVE_AFTER_MS}. Restoring or using a session lists it in
 * `kept`, with the time, which exempts it from the idle rule. An agent CLI
 * that keeps an archive of its own adds its mark, and the newest of these
 * choices wins. New activity overrides an archive: see {@link isStillArchived}.
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
  /**
   * Session id → epoch ms the user restored or used it, exempt from the idle
   * rule; 0 where that predates restores being timed.
   */
  kept: ReadonlyMap<string, number>
}

interface PersistedArchive {
  version: 3
  sessions: Record<string, number>
  kept: Record<string, number>
}

let archived = new Map<string, number>()
let kept = new Map<string, number>()
const archiveListeners = new Set<(sessionIds: readonly string[]) => void>()

export function subscribeSessionArchive(listener: (sessionIds: readonly string[]) => void): () => void {
  archiveListeners.add(listener)
  return () => { archiveListeners.delete(listener) }
}

const changeListeners = new Set<() => void>()

/** Called after every write that archived, restored or forgot a session. */
export function subscribeArchiveChanges(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => { changeListeners.delete(listener) }
}

async function persistChange(): Promise<void> {
  await file.persist()
  for (const listener of changeListeners) listener()
}

function readTimes(record: unknown, into: Map<string, number>): void {
  if (typeof record !== "object" || record === null) return
  for (const [sessionId, at] of Object.entries(record)) {
    if (sessionId && typeof at === "number" && Number.isFinite(at)) into.set(sessionId, at)
  }
}

const file = new SessionConfigFile(SESSION_ARCHIVE_FILE, {
  reset() {
    archived = new Map()
    kept = new Map()
  },
  apply(parsed) {
    if (typeof parsed !== "object" || parsed === null) return
    const candidate = parsed as { sessions?: unknown; kept?: unknown }
    readTimes(candidate.sessions, archived)
    // Version 2 listed kept sessions without a time.
    if (Array.isArray(candidate.kept)) {
      for (const sessionId of candidate.kept) {
        if (typeof sessionId === "string" && sessionId) kept.set(sessionId, 0)
      }
    } else {
      readTimes(candidate.kept, kept)
    }
  },
  snapshot(): PersistedArchive {
    return { version: 3, sessions: Object.fromEntries(archived), kept: Object.fromEntries(kept) }
  },
})

export async function readArchive(): Promise<ArchiveSnapshot> {
  await file.load()
  return { archived: new Map(archived), kept: new Map(kept) }
}

export interface ArchiveWrite {
  now?: number
  /**
   * The user's own choice: recorded at `now` even where the session already
   * stands that way, so it outranks an older mark of the agent CLI's.
   */
  byUser?: boolean
}

/**
 * Archive or restore sessions. Returns the ids whose state changed; nothing is
 * written for a no-op. Restoring also marks the session kept so the idle rule
 * does not archive it again.
 */
export async function setSessionsArchived(
  sessionIds: readonly string[],
  archive: boolean,
  { now = Date.now(), byUser = false }: ArchiveWrite = {},
): Promise<string[]> {
  await file.load()
  const changed: string[] = []
  let written = false
  for (const sessionId of sessionIds) {
    const stateChanges = archive
      ? !archived.has(sessionId) || kept.has(sessionId)
      : archived.has(sessionId) || !kept.has(sessionId)
    if (!stateChanges && !byUser) continue
    if (archive) {
      archived.set(sessionId, byUser ? now : archived.get(sessionId) ?? now)
      kept.delete(sessionId)
    } else {
      archived.delete(sessionId)
      kept.set(sessionId, now)
    }
    written = true
    if (stateChanges) changed.push(sessionId)
  }
  if (written) await persistChange()
  if (archive) for (const listener of archiveListeners) listener(sessionIds)
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
  if (changed) await persistChange()
}

/**
 * Whether a manual archive still holds for a transcript last written at
 * `mtimeMs`. Activity well after archiving means the session was resumed, and
 * a resumed session belongs back in the sidebar.
 */
export function isStillArchived(archivedAt: number | undefined, mtimeMs: number): boolean {
  return archivedAt !== undefined && mtimeMs <= archivedAt + REACTIVATION_GRACE_MS
}

interface ArchiveChoice {
  archived: boolean
  at: number
}

/** The newest archive or restore on record: Cogpit's own, or the agent CLI's mark. */
function latestChoice(snapshot: ArchiveSnapshot, sessionId: string, mark: ArchiveMark | undefined): ArchiveChoice | null {
  const choices: ArchiveChoice[] = []
  const archivedAt = snapshot.archived.get(sessionId)
  if (archivedAt !== undefined) choices.push({ archived: true, at: archivedAt })
  const keptAt = snapshot.kept.get(sessionId)
  if (keptAt !== undefined) choices.push({ archived: false, at: keptAt })
  if (mark) choices.push({ archived: mark.archived, at: mark.atMs })
  let latest: ArchiveChoice | null = null
  for (const choice of choices) if (!latest || choice.at > latest.at) latest = choice
  return latest
}

/**
 * Why a session is archived right now, or null when it is listed. `mark` is
 * the agent CLI's own archive mark for the session, where it keeps one.
 */
export function archiveReason(
  snapshot: ArchiveSnapshot,
  sessionId: string,
  mtimeMs: number,
  now = Date.now(),
  mark?: ArchiveMark,
): ArchiveReason | null {
  const choice = latestChoice(snapshot, sessionId, mark)
  if (choice?.archived && isStillArchived(choice.at, mtimeMs)) return "manual"
  if (choice && !choice.archived) return null
  if (!snapshot.kept.has(sessionId) && now - mtimeMs > AUTO_ARCHIVE_AFTER_MS) return "inactive"
  return null
}

export function __resetSessionArchiveForTest(): void {
  file.resetForTest()
}
