import { SessionConfigFile } from "./sessionConfigFile"
import type { Handoff } from "../workspaceTransfer/handoff"

/**
 * How Cogpit came to start a session through the session CLI or
 * `create-and-send`: which session asked for it, and which hub device it runs
 * on. An orchestrator lists and stops the sessions it spawned from this, and
 * the hub finds a remote session's device without asking every device.
 */

const ORIGINS_FILE = "session-origins.json"
/** The parent-only record this file replaced; its entries are a subset of an origin. */
const LINEAGE_FILE = "session-lineage.json"

export interface SessionOrigin {
  parentSessionId?: string
  /** The hub device the session runs on; absent for sessions on this machine. */
  deviceId?: string
  /** Its questions and approvals go to the user in Cogpit rather than to the parent agent. */
  asksUser?: true
  /** The repository sent to the device for it, to fetch its work back. */
  handoff?: Handoff
  createdAt: number
}

interface PersistedOrigins {
  version: 1
  sessions: Record<string, SessionOrigin>
}

let origins = new Map<string, SessionOrigin>()

const optionalString = (value: unknown) => (typeof value === "string" && value ? value : undefined)

function handoffFrom(value: unknown): Handoff | undefined {
  const entry = value as Partial<Handoff> | undefined
  const repoRoot = optionalString(entry?.repoRoot)
  const base = optionalString(entry?.base)
  const workspaceId = optionalString(entry?.workspaceId)
  const branch = optionalString(entry?.branch)
  return repoRoot && base && workspaceId && branch ? { repoRoot, base, workspaceId, branch } : undefined
}

const file = new SessionConfigFile(ORIGINS_FILE, {
  reset() {
    origins = new Map()
  },
  apply(parsed) {
    const sessions = (parsed as Partial<PersistedOrigins> | null)?.sessions
    if (typeof sessions !== "object" || sessions === null) return
    for (const [sessionId, entry] of Object.entries(sessions)) {
      if (typeof entry?.createdAt !== "number") continue
      const parentSessionId = optionalString(entry.parentSessionId)
      const deviceId = optionalString(entry.deviceId)
      const asksUser = entry.asksUser === true
      const handoff = handoffFrom(entry.handoff)
      if (!parentSessionId && !deviceId && !asksUser) continue
      origins.set(sessionId, {
        ...(parentSessionId ? { parentSessionId } : {}),
        ...(deviceId ? { deviceId } : {}),
        ...(asksUser ? { asksUser } : {}),
        ...(handoff ? { handoff } : {}),
        createdAt: entry.createdAt,
      })
    }
  },
  snapshot(): PersistedOrigins {
    return { version: 1, sessions: Object.fromEntries(origins) }
  },
}, LINEAGE_FILE)

/** Merge what is known about a session's origin; a session is never its own parent. */
export async function recordSessionOrigin(
  sessionId: string,
  origin: Omit<SessionOrigin, "createdAt">,
  now = Date.now(),
): Promise<void> {
  const parentSessionId = origin.parentSessionId === sessionId ? undefined : origin.parentSessionId
  if (!parentSessionId && !origin.deviceId && !origin.asksUser) return
  await file.load()
  const existing = origins.get(sessionId)
  const next: SessionOrigin = {
    ...existing,
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(origin.deviceId ? { deviceId: origin.deviceId } : {}),
    ...(origin.asksUser ? { asksUser: true as const } : {}),
    ...(origin.handoff ? { handoff: origin.handoff } : {}),
    createdAt: existing?.createdAt ?? now,
  }
  if (JSON.stringify(existing) === JSON.stringify(next)) return
  origins.set(sessionId, next)
  await file.persist()
}

export async function sessionOrigin(sessionId: string): Promise<SessionOrigin | null> {
  await file.load()
  return origins.get(sessionId) ?? null
}

/** Sessions started by `parentSessionId`, oldest first. */
export async function sessionChildren(parentSessionId: string): Promise<string[]> {
  await file.load()
  return [...origins]
    .filter(([, origin]) => origin.parentSessionId === parentSessionId)
    .sort(([, a], [, b]) => a.createdAt - b.createdAt)
    .map(([sessionId]) => sessionId)
}

/** Forget a session's handed-over workspace once it has been discarded. */
export async function clearSessionHandoff(sessionId: string): Promise<void> {
  await file.load()
  const origin = origins.get(sessionId)
  if (!origin?.handoff) return
  const { handoff: _handoff, ...rest } = origin
  void _handoff
  origins.set(sessionId, rest)
  await file.persist()
}

/** Sessions whose questions go to the user, started since `sinceMs`. */
export async function sessionsAskingUser(sinceMs: number): Promise<Array<{ sessionId: string; origin: SessionOrigin }>> {
  await file.load()
  return [...origins]
    .filter(([, origin]) => origin.asksUser && origin.createdAt >= sinceMs)
    .map(([sessionId, origin]) => ({ sessionId, origin }))
}

export async function forgetSessionOrigins(sessionIds: readonly string[]): Promise<void> {
  await file.load()
  let changed = false
  for (const sessionId of sessionIds) {
    if (origins.delete(sessionId)) changed = true
  }
  if (changed) await file.persist()
}

export function __resetSessionOriginsForTest(): void {
  file.resetForTest()
}
