import type { AgentKind } from "../../shared/session/agent-descriptors"
import { allStores, type AgentStore, type SessionFileInfo } from "../agents"
import {
  getCodexSessionIdentity,
  getCopilotSessionIdentity,
  getSessionMeta,
} from "../sessionMetadata"
import { createSessionInventoryCache } from "./sessionInventoryCache"

/**
 * Session identity for every transcript an agent has on disk, cached briefly so
 * the routes that all need it share one cold walk.
 *
 * Listing gives paths and mtimes; the project a session belongs to lives inside
 * the file, so each entry costs one bounded head read. That is the expensive
 * part, and the reason this is cached rather than recomputed per route.
 */

export interface SessionInventoryEntry extends SessionFileInfo {
  sessionId: string
  cwd: string
  gitBranch: string
  isSubagent: boolean
  parentSessionId: string | null
}

interface SessionIdentity {
  sessionId: string
  cwd: string
  gitBranch: string
  isSubagent: boolean
  parentSessionId: string | null
}

/**
 * Cheap head-read identity, where the agent has one. Claude has no such
 * fast path, so it falls straight through to the full metadata parse.
 */
const FAST_IDENTITY: Partial<Record<AgentKind, (filePath: string) => Promise<SessionIdentity | null>>> = {
  codex: getCodexSessionIdentity,
  copilot: getCopilotSessionIdentity,
}

async function readEntry(
  store: AgentStore,
  file: SessionFileInfo,
): Promise<SessionInventoryEntry | null> {
  const fastIdentity = FAST_IDENTITY[store.kind]
  let identity = fastIdentity ? await fastIdentity(file.filePath) : null

  // Preserve unusual or legacy transcripts whose identity is not fully present
  // in the head read. Only those files pay for the full metadata parse.
  if (!identity) {
    try {
      const meta = await getSessionMeta(file.filePath)
      if (!meta.cwd) return null
      identity = {
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        gitBranch: meta.gitBranch,
        isSubagent: meta.isSubagent === true,
        parentSessionId: meta.parentSessionId ?? null,
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

const caches = new Map<AgentKind, ReturnType<typeof createSessionInventoryCache<SessionInventoryEntry>>>(
  allStores().map((store) => [
    store.kind,
    createSessionInventoryCache(() => loadInventory(store)),
  ]),
)

/** Share the cold walk and identity reads across concurrent routes. */
export function getSessionInventory(kind: AgentKind): Promise<SessionInventoryEntry[]> {
  return caches.get(kind)?.get() ?? Promise.resolve([])
}

/** Drop the cached inventory for one agent, or for all of them. */
export function invalidateSessionInventory(kind?: AgentKind): void {
  for (const [cachedKind, cache] of caches) {
    if (kind === undefined || cachedKind === kind) cache.invalidate()
  }
}
