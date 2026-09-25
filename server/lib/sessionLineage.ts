import { SessionConfigFile } from "./sessionConfigFile"

/**
 * Which session started which. An agent that creates a session through the
 * session CLI or `create-and-send` passes its own id, so an orchestrator can
 * list and stop the sessions it spawned without keeping its own bookkeeping.
 */

const LINEAGE_FILE = "session-lineage.json"

interface LineageEntry {
  parentSessionId: string
  createdAt: number
}

interface PersistedLineage {
  version: 1
  sessions: Record<string, LineageEntry>
}

let entries = new Map<string, LineageEntry>()

const file = new SessionConfigFile(LINEAGE_FILE, {
  reset() {
    entries = new Map()
  },
  apply(parsed) {
    const sessions = (parsed as Partial<PersistedLineage> | null)?.sessions
    if (typeof sessions !== "object" || sessions === null) return
    for (const [sessionId, entry] of Object.entries(sessions)) {
      if (typeof entry?.parentSessionId === "string" && typeof entry.createdAt === "number") {
        entries.set(sessionId, { parentSessionId: entry.parentSessionId, createdAt: entry.createdAt })
      }
    }
  },
  snapshot(): PersistedLineage {
    return { version: 1, sessions: Object.fromEntries(entries) }
  },
})

export async function recordSessionParent(
  sessionId: string,
  parentSessionId: string,
  now = Date.now(),
): Promise<void> {
  if (sessionId === parentSessionId) return
  await file.load()
  if (entries.get(sessionId)?.parentSessionId === parentSessionId) return
  entries.set(sessionId, { parentSessionId, createdAt: now })
  await file.persist()
}

export async function sessionParent(sessionId: string): Promise<string | null> {
  await file.load()
  return entries.get(sessionId)?.parentSessionId ?? null
}

/** Sessions started by `parentSessionId`, oldest first. */
export async function sessionChildren(parentSessionId: string): Promise<string[]> {
  await file.load()
  return [...entries]
    .filter(([, entry]) => entry.parentSessionId === parentSessionId)
    .sort(([, a], [, b]) => a.createdAt - b.createdAt)
    .map(([sessionId]) => sessionId)
}

export async function forgetSessionLineage(sessionIds: readonly string[]): Promise<void> {
  await file.load()
  let changed = false
  for (const sessionId of sessionIds) {
    if (entries.delete(sessionId)) changed = true
  }
  if (changed) await file.persist()
}

export function __resetSessionLineageForTest(): void {
  file.resetForTest()
}
