import { rm } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { LIBRARY_MAX_PAGE, LIBRARY_PAGE, LIBRARY_SCOPES, LIBRARY_TABS, type LibraryResponse, type LibraryScope, type LibraryTab } from "../../shared/library/types"
import { authorizeSession, itemVisibilityFor, markDecided, mayActHostWide, sendSessionHidden, visibilityFor } from "../edition"
import { sendJson, type UseFn } from "../http"
import { libraryFilesDir, libraryStore } from "../library"
import { keptFilePath } from "../library/keep"
import { listLibrary, type LibraryQuery } from "../library/list"
import type { LibraryStore } from "../library/store"
import { memoryIndexer } from "../memory"
import { transcriptExists } from "../memory/store"

function readQuery(params: URLSearchParams): LibraryQuery | string {
  const scope = (params.get("scope") ?? "all") as LibraryScope
  if (!LIBRARY_SCOPES.includes(scope)) return `scope must be one of ${LIBRARY_SCOPES.join(", ")}`
  const tab = (params.get("tab") || undefined) as LibraryTab | undefined
  if (tab && !LIBRARY_TABS.includes(tab)) return `tab must be one of ${LIBRARY_TABS.join(", ")}`
  const sessionId = params.get("session") || undefined
  const project = params.get("project") || undefined
  if (scope === "session" && !sessionId) return "the session scope needs session"
  if (scope === "project" && !project) return "the project scope needs project"
  const limitParam = params.get("limit")
  const limit = limitParam === null ? LIBRARY_PAGE : Number(limitParam)
  if (!Number.isInteger(limit) || limit < 1 || limit > LIBRARY_MAX_PAGE) return `limit must be a whole number from 1 to ${LIBRARY_MAX_PAGE}`
  return {
    scope, tab, limit, sessionId, project,
    text: params.get("q") || undefined,
    before: params.get("before") || undefined,
  }
}

/**
 * Sessions the caller may see, as session search decides them: text whose
 * transcript is gone has no session left to check, so only a host-wide
 * caller who sees everything is shown it.
 */
function visibleTo(req: IncomingMessage): ((sessionId: string, sourceFile: string) => Promise<boolean>) | null {
  const check = visibilityFor(req)
  if (check.nothing) return null
  const showArchived = check.everything && mayActHostWide(req)
  return async (sessionId, sourceFile) => (showArchived || transcriptExists(sourceFile))
    && (check.everything || (await check(sessionId)) !== "hidden")
}

async function handleList(req: IncomingMessage, res: ServerResponse, store: LibraryStore | null): Promise<void> {
  const query = readQuery(new URL(req.url ?? "/", "http://localhost").searchParams)
  if (typeof query === "string") return sendJson(res, 400, { error: query })
  const visible = visibleTo(req)
  const status = { available: store !== null, pendingFiles: memoryIndexer()?.counts().pendingFiles ?? 0 }
  if (!store || !visible) {
    return sendJson(res, 200, { ...status, counts: { media: 0, link: 0, file: 0 }, items: [], viewIds: [], next: null, sessions: {} } satisfies LibraryResponse)
  }
  const listing = await listLibrary(store, query, { filesDir: libraryFilesDir(), visible })
  sendJson(res, 200, { ...status, ...listing } satisfies LibraryResponse)
}

/** Takes an item, and everything it stands for that the caller may change, out of the library; removing it again answers the same. */
async function handleRemove(req: IncomingMessage, res: ServerResponse, store: LibraryStore | null, id: number): Promise<void> {
  const row = store?.item(id) ?? null
  if (!store || !row) {
    markDecided(req)
    sendSessionHidden(res, null)
    return
  }
  if (!(await authorizeSession(req, res, { sessionId: row.session_id, readByServer: true }, "interact"))) return
  if (row.removed) {
    sendJson(res, 200, { removed: 0 })
    return
  }
  const may = itemVisibilityFor(req)
  const ids: number[] = []
  for (const duplicate of store.duplicates(row)) {
    if (duplicate.id === row.id || await may(duplicate.session_id, "interact")) ids.push(duplicate.id)
  }
  const orphans = store.remove(ids)
  const filesDir = libraryFilesDir()
  await Promise.all(orphans.map((file) => rm(keptFilePath(filesDir, file.hash, file.ext), { force: true })))
  sendJson(res, 200, { removed: ids.length })
}

/**
 * What agents shared in their replies, as far as the caller may see the
 * sessions: `GET /api/library` lists a tab for a scope, and
 * `DELETE /api/library/items/<id>` takes an item out.
 */
export function registerLibraryRoutes(use: UseFn): void {
  use("/api/library", async (req, res, next) => {
    const path = (req.url ?? "").split("?")[0]!
    if (req.method === "GET" && (path === "" || path === "/")) return handleList(req, res, libraryStore())
    const item = /^\/items\/(\d+)$/.exec(path)
    if (req.method === "DELETE" && item) return handleRemove(req, res, libraryStore(), Number(item[1]))
    next()
  })
}
