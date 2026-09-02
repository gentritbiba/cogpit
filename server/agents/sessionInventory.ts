import { createSessionInventoryCache } from "../lib/sessionInventoryCache"
import { readTranscriptHead } from "./transcriptHead"
import type { AgentStore, SessionFileInfo, SessionIdentity } from "./types"

/**
 * Session identity for every transcript a store has on disk, cached briefly so
 * the routes that all need it share one cold walk.
 *
 * Listing gives paths and mtimes; the project a session belongs to lives inside
 * the file, so each entry costs one bounded head read. That is the expensive
 * part, and the reason this is cached rather than recomputed per route.
 */

export interface SessionInventoryEntry extends SessionFileInfo, SessionIdentity {}

async function readEntry(
  store: AgentStore,
  file: SessionFileInfo,
): Promise<SessionInventoryEntry | null> {
  let identity = await store.readIdentity(file.filePath)

  // Preserve unusual or legacy transcripts whose identity is not fully present
  // in the head read. Only those files pay for the full metadata parse.
  if (!identity) {
    try {
      const meta = await store.readSessionMeta(file.filePath, await readTranscriptHead(file.filePath))
      if (!meta.cwd) return null
      identity = {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        gitBranch: meta.gitBranch,
        isSubagent: meta.isSubagent,
        parentSessionId: meta.parentSessionId,
      }
    } catch {
      return null
    }
  }

  // The path wins over the header where the layout encodes the id, because a
  // forked or resumed session can carry a header id from the session it came
  // from while living in a directory named after itself.
  const sessionId = store.descriptor.sessionFile.sessionId(file.fileName) ?? identity.sessionId
  return { ...file, ...identity, sessionId }
}

async function loadInventory(store: AgentStore): Promise<SessionInventoryEntry[]> {
  const files = await store.listSessionFiles()
  const entries = await Promise.all(files.map((file) => readEntry(store, file)))
  return entries.flatMap((entry) => entry ? [entry] : [])
}

type InventoryCache = ReturnType<typeof createSessionInventoryCache<SessionInventoryEntry>>

const caches = new WeakMap<AgentStore, InventoryCache>()

/** Share the cold walk and identity reads across concurrent callers. */
export function inventoryFor(store: AgentStore): Promise<SessionInventoryEntry[]> {
  let cache = caches.get(store)
  if (!cache) {
    cache = createSessionInventoryCache(() => loadInventory(store))
    caches.set(store, cache)
  }
  return cache.get()
}
