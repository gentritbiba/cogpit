import type { EventEmitter } from "node:events"
import { splitInstanceSessionId } from "../../shared/session/instances"
import { SESSION_LOOKUP_ORDER, allStores, storeFor } from "../agents"
import { isSinglePathSegment } from "../agents/containment"
import { flushFacts, startFactPersistence } from "./facts"
import { startRowRechecks } from "./rows"
import { enableSessionCatalogs } from "./storeCatalog"

/**
 * The session catalog: every store's session files kept current by
 * file-system events, with what was read from each file remembered across
 * restarts. Listings (`allTopLevelSessions`, `store.listProjects`,
 * `store.listProjectSessionFiles`) read it once it is running.
 *
 * - `catalogVersion()` / `subscribeCatalog()`: a counter bumped on every
 *   change, each marked `visible` (a session came or went, or a row's
 *   metadata or status changed) or `touch` (only size and mtime moved).
 *   `markCatalogChanged()` lets row inputs without a file event bump it.
 * - `sessionFileFor(id)`: the transcript for a session id, without a walk.
 * - `catalogRow(file)` / `peekCatalogRow(file)`: a row's metadata and status.
 */

export {
  catalogVersion,
  markCatalogChanged,
  subscribeCatalog,
  type CatalogChange,
  type CatalogChangeKind,
} from "./changes"
export { catalogRow, peekCatalogRow, type CatalogRow } from "./rows"

/** The transcript the running catalog lists for `sessionId`, or null; the file may since have gone. */
export function sessionFileFor(sessionId: string): string | null {
  if (!isSinglePathSegment(sessionId)) return null
  const instanceId = splitInstanceSessionId(sessionId).instanceId
  if (instanceId !== "default") {
    return allStores().find((store) => store.instanceId === instanceId)?.knownSessionFile(sessionId) ?? null
  }
  for (const kind of SESSION_LOOKUP_ORDER) {
    const filePath = storeFor(kind).knownSessionFile(sessionId)
    if (filePath) return filePath
  }
  return null
}

let started = false

/** Start the catalog: load what the last run saved and serve listings from it from now on. */
export function startSessionCatalog(): void {
  if (started) return
  started = true
  enableSessionCatalogs()
  startRowRechecks()
  void startFactPersistence()
}

/** Server shells start the catalog once the first response is out, so it never delays that one. */
const IDLE_START_MS = 5_000

export function startSessionCatalogAfterFirstResponse(server: EventEmitter): void {
  const timer = setTimeout(startSessionCatalog, IDLE_START_MS)
  timer.unref?.()
  server.once("request", (_req: unknown, res: EventEmitter) => {
    res.once("finish", () => {
      clearTimeout(timer)
      setImmediate(startSessionCatalog)
    })
  })
}

/** Save what the catalog learned since its last save; for a server shutting down. */
export function flushSessionCatalog(): Promise<void> {
  return flushFacts().catch((error: unknown) => console.warn("[sessionCatalog] could not save the catalog:", error))
}
