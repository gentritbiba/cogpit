/**
 * Where an agent's `default` browser goes. The shim owns the routing, so the
 * server leaves it notes: `owners/<session id>` names the profile that
 * session's `default` opens, and `owners/.unowned` the one for an agent Cogpit
 * spawned that no note names — a process serving many sessions, or a session
 * nobody owns. Without a note `default` is the host's own profile, which is
 * all personal edition ever uses: it writes no note.
 *
 * Notes are written as Cogpit spawns an agent, so a session whose owner
 * changes browses as the new owner from its next start. The sweeper drops the
 * note of a session that is neither live nor started within the hour.
 */
import { readdirSync, rmSync, statSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { sessionBrowserProfile } from "../edition"
import { writeIfChanged } from "./files"
import {
  DEFAULT_BROWSER,
  isThrowawayName,
  isValidBrowserName,
  isValidCogpitSessionId,
  ownersDir,
  UNOWNED_FILE,
} from "./paths"

const STALE_NOTE_MS = 60 * 60 * 1000

/** A profile the shim may route `default` to: a named browser other than the host's own. */
function routable(profile: string | null): string | null {
  if (profile === null || !isValidBrowserName(profile) || isThrowawayName(profile)) return null
  return profile === DEFAULT_BROWSER ? null : profile
}

/** Written even when unchanged, so its age says when the session last started. */
function writeNote(file: string, profile: string | null): void {
  const path = join(ownersDir(), file)
  if (profile === null) {
    rmSync(path, { force: true })
    return
  }
  writeIfChanged(path, `${profile}\n`)
  const now = new Date()
  utimesSync(path, now, now)
}

/**
 * Tell the shim where `sessionId`'s agent browses, and where an agent no note
 * names does. An id that is not a valid session id gets no note of its own.
 */
export function noteBrowserProfiles(sessionId: string): void {
  writeNote(UNOWNED_FILE, routable(sessionBrowserProfile(null)))
  if (isValidCogpitSessionId(sessionId)) writeNote(sessionId, routable(sessionBrowserProfile(sessionId)))
}

/** Drop the note of every session that is neither live nor started within the hour. */
export function reapBrowserProfileNotes(isCogpitSessionLive: (id: string) => boolean, now = Date.now()): void {
  let entries: string[]
  try {
    entries = readdirSync(ownersDir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (!isValidCogpitSessionId(entry) || isCogpitSessionLive(entry)) continue
    const path = join(ownersDir(), entry)
    try {
      if (now - statSync(path).mtimeMs >= STALE_NOTE_MS) rmSync(path, { force: true })
    } catch {
      // Gone already, or unreadable; the next sweep tries again.
    }
  }
}
