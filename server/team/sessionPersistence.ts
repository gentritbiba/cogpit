import { createHash } from "node:crypto"
import { chmod, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { SESSION_ABSOLUTE_TTL_MS, type SessionPrincipal } from "./constants"

/**
 * Restart-surviving login sessions for team edition.
 *
 * Persists `{ sessions: Row[] }` to `<dataRoot>/team/sessions.json` (0600 in a
 * 0700 directory). Rows carry only a sha256 token hash — the token itself
 * already has 256 bits of entropy, so a fast hash is the right primitive and
 * a leaked file never yields usable tokens. Only userId and createdAt are
 * persisted per session: username and role are re-read from the users store at
 * rehydrate time so role changes and disables apply across restarts.
 *
 * Mutations hit the in-memory rows synchronously — a revoked token must not be
 * restorable even for an instant — while the durable snapshot writes trail
 * serially through a single promise chain.
 */

interface PersistedSession {
  tokenHash: string
  userId: string
  createdAt: number
  expiresAt: number
}

// ── Module state ─────────────────────────────────────────────────────

let sessionsPath: string | null = null
const sessions = new Map<string, PersistedSession>()
let operationQueue: Promise<void> = Promise.resolve()

export function __resetForTest(): void {
  sessionsPath = null
  sessions.clear()
  operationQueue = Promise.resolve()
}

/** Resolves once every mutation enqueued so far has settled. */
export function __flushForTest(): Promise<void> {
  return operationQueue
}

// ── Persistence ──────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation)
  // A rejected operation belongs to its caller. Keep a handled tail so later
  // operations still run rather than inheriting the rejection.
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function replaceSessions(next: ReadonlyMap<string, PersistedSession>): void {
  sessions.clear()
  for (const [tokenHash, row] of next) sessions.set(tokenHash, row)
}

// Snapshots the rows when the write actually runs, so back-to-back mutations
// coalesce and the last write always reflects the final in-memory state.
function schedulePersist(): Promise<void> {
  return enqueueOperation(async () => {
    if (!sessionsPath) return
    await writeOwnerOnlyJson(sessionsPath, { sessions: [...sessions.values()] }, 0o600)
  })
}

function isLiveRow(row: unknown, now: number): row is PersistedSession {
  if (typeof row !== "object" || row === null) return false
  const candidate = row as Partial<PersistedSession>
  return (
    typeof candidate.tokenHash === "string"
    && typeof candidate.userId === "string"
    && Number.isFinite(candidate.createdAt)
    && Number.isFinite(candidate.expiresAt)
    && (candidate.expiresAt as number) > now
  )
}

/**
 * Point the store at `<dir>/sessions.json` and load it, pruning expired rows.
 * A missing or corrupt file starts empty — unlike the users store, an empty
 * session store fails toward re-login, never toward an auth bypass.
 */
export async function initSessionPersistence(dir: string): Promise<void> {
  await enqueueOperation(async () => {
    await mkdir(dir, { recursive: true })
    // Windows has no POSIX modes: chmod only toggles the read-only bit there.
    if (process.platform !== "win32") {
      await chmod(dir, 0o700)
    }

    const nextPath = join(dir, "sessions.json")
    let raw: string | null = null
    try {
      raw = await readFile(nextPath, "utf-8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }

    const loaded = new Map<string, PersistedSession>()
    if (raw !== null) {
      const now = Date.now()
      try {
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.sessions)) {
          for (const row of parsed.sessions) {
            if (isLiveRow(row, now)) loaded.set(row.tokenHash, row)
          }
        }
      } catch {
        // Corrupt store: start empty and let the next mutation rewrite it.
      }
    }

    sessionsPath = nextPath
    replaceSessions(loaded)
  })
}

// ── Operations ───────────────────────────────────────────────────────

// Init ordering: initSessionPersistence's queued load replaces the row map
// wholesale, so a row persisted while that load is still pending would be
// silently dropped (and before init there is no sessionsPath to write to).
// Server boot awaits init before any login can create sessions.
export function persistSession(
  token: string,
  principal: SessionPrincipal,
  createdAt: number,
): Promise<void> {
  const tokenHash = hashToken(token)
  sessions.set(tokenHash, {
    tokenHash,
    userId: principal.userId,
    createdAt,
    expiresAt: createdAt + SESSION_ABSOLUTE_TTL_MS,
  })
  return schedulePersist()
}

/** Synchronous lookup for the validate path; expired rows are treated as gone. */
export function restoreSession(token: string): { userId: string; createdAt: number } | null {
  const row = sessions.get(hashToken(token))
  if (!row || row.expiresAt <= Date.now()) return null
  return { userId: row.userId, createdAt: row.createdAt }
}

export function removeSession(token: string): Promise<void> {
  if (!sessions.delete(hashToken(token))) return Promise.resolve()
  return schedulePersist()
}

export function removeSessionsForUser(userId: string): Promise<void> {
  let changed = false
  for (const [tokenHash, row] of sessions) {
    if (row.userId !== userId) continue
    sessions.delete(tokenHash)
    changed = true
  }
  return changed ? schedulePersist() : Promise.resolve()
}

export function clearAllSessions(): Promise<void> {
  if (sessions.size === 0) return Promise.resolve()
  sessions.clear()
  return schedulePersist()
}
