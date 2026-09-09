import { createHash } from "node:crypto"
import { chmod, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { replaceAll, serialQueue } from "../lib/serialQueue"
import {
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  type SessionPrincipal,
} from "./constants"

/**
 * Restart-surviving login sessions for team edition.
 *
 * Persists `{ sessions: Row[] }` to `<dataRoot>/team/sessions.json` (0600 in a
 * 0700 directory). Rows carry only a sha256 token hash — the token itself
 * already has 256 bits of entropy, so a fast hash is the right primitive and
 * a leaked file never yields usable tokens. Username and role are re-read from
 * the users store at rehydrate time so role changes and disables apply across
 * restarts; last activity is durable so a restart cannot reset the idle TTL.
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
  lastActivity: number
}

// ── Module state ─────────────────────────────────────────────────────

let sessionsPath: string | null = null
const sessions = new Map<string, PersistedSession>()
const queue = serialQueue()
let stateVersion = 0
let persistedVersion = 0

export function __resetForTest(): void {
  sessionsPath = null
  sessions.clear()
  queue.reset()
  stateVersion = 0
  persistedVersion = 0
}

/** Resolves once every mutation enqueued so far has settled. */
export function __flushForTest(): Promise<void> {
  return flushSessionPersistence()
}

/** Wait for all queued durable mutations (also used during graceful shutdown). */
export function flushSessionPersistence(): Promise<void> {
  return schedulePersist()
}

// ── Persistence ──────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

// Snapshots the rows when the write actually runs, so back-to-back mutations
// coalesce and the last write always reflects the final in-memory state.
function schedulePersist(): Promise<void> {
  return queue.run(async () => {
    if (!sessionsPath || persistedVersion === stateVersion) return
    const version = stateVersion
    await writeOwnerOnlyJson(sessionsPath, { sessions: [...sessions.values()] }, 0o600)
    persistedVersion = version
  })
}

function markDirty(): void {
  stateVersion += 1
}

function parseLiveRow(row: unknown, now: number): PersistedSession | null {
  if (typeof row !== "object" || row === null) return null
  const candidate = row as Partial<PersistedSession>
  if (
    typeof candidate.tokenHash !== "string"
    || typeof candidate.userId !== "string"
    || !Number.isFinite(candidate.createdAt)
    || !Number.isFinite(candidate.expiresAt)
  ) return null

  // Rows written before idle persistence existed conservatively inherit their
  // creation time. They may require an earlier re-login, but can never gain a
  // fresh idle window merely because the process restarted.
  const lastActivity = Number.isFinite(candidate.lastActivity)
    ? candidate.lastActivity as number
    : candidate.createdAt as number
  if ((candidate.expiresAt as number) <= now || now - lastActivity > SESSION_IDLE_TTL_MS) {
    return null
  }
  return {
    tokenHash: candidate.tokenHash,
    userId: candidate.userId,
    createdAt: candidate.createdAt as number,
    expiresAt: candidate.expiresAt as number,
    lastActivity,
  }
}

/**
 * Point the store at `<dir>/sessions.json` and load it, pruning expired rows.
 * A missing or corrupt file starts empty — unlike the users store, an empty
 * session store fails toward re-login, never toward an auth bypass.
 */
export async function initSessionPersistence(dir: string): Promise<void> {
  await queue.run(async () => {
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
    let needsRewrite = false
    if (raw !== null) {
      const now = Date.now()
      try {
        const parsed = JSON.parse(raw)
        if (parsed && Array.isArray(parsed.sessions)) {
          for (const row of parsed.sessions) {
            const live = parseLiveRow(row, now)
            if (live) {
              loaded.set(live.tokenHash, live)
              if (!Number.isFinite((row as Partial<PersistedSession>).lastActivity)) needsRewrite = true
            } else {
              needsRewrite = true
            }
          }
        } else {
          needsRewrite = true
        }
      } catch {
        // Corrupt session state fails toward re-login and is repaired now.
        needsRewrite = true
      }
    }

    sessionsPath = nextPath
    replaceAll(sessions, loaded)
    if (raw !== null && needsRewrite) {
      await writeOwnerOnlyJson(nextPath, { sessions: [...loaded.values()] }, 0o600)
    }
    stateVersion = 0
    persistedVersion = 0
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
  lastActivity: number = createdAt,
): Promise<void> {
  const tokenHash = hashToken(token)
  sessions.set(tokenHash, {
    tokenHash,
    userId: principal.userId,
    createdAt,
    expiresAt: createdAt + SESSION_ABSOLUTE_TTL_MS,
    lastActivity,
  })
  markDirty()
  return schedulePersist()
}

/** Synchronous lookup; the security layer applies TTLs and removes stale rows. */
export function restoreSession(token: string): { userId: string; createdAt: number; lastActivity: number } | null {
  const row = sessions.get(hashToken(token))
  if (!row) return null
  return { userId: row.userId, createdAt: row.createdAt, lastActivity: row.lastActivity }
}

export function touchSession(token: string, lastActivity: number): Promise<void> {
  const row = sessions.get(hashToken(token))
  if (!row || lastActivity <= row.lastActivity) return schedulePersist()
  row.lastActivity = lastActivity
  markDirty()
  return schedulePersist()
}

export function removeSession(token: string): Promise<void> {
  if (sessions.delete(hashToken(token))) markDirty()
  return schedulePersist()
}

export function removeSessionsForUser(userId: string): Promise<void> {
  let changed = false
  for (const [tokenHash, row] of sessions) {
    if (row.userId !== userId) continue
    sessions.delete(tokenHash)
    changed = true
  }
  if (changed) markDirty()
  return schedulePersist()
}

export function clearAllSessions(): Promise<void> {
  if (sessions.size > 0) {
    sessions.clear()
    markDirty()
  }
  return schedulePersist()
}
