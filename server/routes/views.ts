import type { IncomingMessage, ServerResponse } from "node:http"
import { catchAsyncErrors, sendJson, withJsonBody, type UseFn } from "../http"
import { isViewId, type StoredViewVersion, type ViewUpdate } from "../../shared/views/stored"
import type { SessionAccessLevel } from "../../shared/contracts/sessionAccess"
import { authorizeHostWide, authorizeSession, itemVisibilityFor, markDecided, sendSessionHidden } from "../edition"
import { shareGuestSessionId } from "../share/requestGuest"
import { VIEW_SHELL_HEADERS, VIEW_SHELL_HTML } from "../views/shell"
import { projectOfCwd, viewStore, viewSummary, ViewStoreError, type ViewRecord, type ViewStore } from "../views/store"

const VERSION = /^[1-9][0-9]{0,6}$/

/**
 * A view belongs to the session that made it: the caller reaches it as they
 * would that session, and one no session made as host-wide. A share guest
 * reads only its shared session's views. False after answering; a missing
 * view answers like a hidden one, so ids cannot be probed.
 */
async function authorizeView(req: IncomingMessage, res: ServerResponse, record: ViewRecord | null, needed: SessionAccessLevel): Promise<boolean> {
  const guest = shareGuestSessionId(req)
  if (!record || (guest !== null && (needed !== "view" || record.sessionId !== guest))) {
    markDecided(req)
    sendSessionHidden(res, null)
    return false
  }
  if (guest !== null) {
    markDecided(req)
    return true
  }
  if (!record.sessionId) return authorizeHostWide(req, res)
  return (await authorizeSession(req, res, { sessionId: record.sessionId, readByServer: true }, needed)) !== null
}

/** The views the caller may see: those of sessions they may see, or of their shared session for a guest. */
async function visibleViews(req: IncomingMessage, records: readonly ViewRecord[]): Promise<ViewRecord[]> {
  const guest = shareGuestSessionId(req)
  if (guest !== null) {
    markDecided(req)
    return records.filter((record) => record.sessionId === guest)
  }
  const visible = itemVisibilityFor(req)
  const shown = await Promise.all(records.map((record) => visible(record.sessionId ?? null)))
  return records.filter((_, index) => shown[index])
}

/**
 * The sandbox a view renders in, which carries no data of its own, and the
 * stored views built on this computer: list, finished pages, rename, pin and
 * delete. A view the caller may not reach answers as if it did not exist.
 */
export function registerViewRoutes(use: UseFn, store: () => ViewStore = viewStore): void {
  use("/api/views", catchAsyncErrors(async (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (req.method === "GET" && url.pathname === "/shell/v1") {
      for (const [name, value] of Object.entries(VIEW_SHELL_HEADERS)) res.setHeader(name, value)
      res.end(VIEW_SHELL_HTML)
      return
    }
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length === 0 && req.method === "GET") {
      const project = url.searchParams.get("project")
      const records = (await store().list()).filter((record) => !project || record.project === projectOfCwd(project))
      sendJson(res, 200, { views: (await visibleViews(req, records)).map(viewSummary) })
      return
    }
    const id = parts[0]
    if (!id || !isViewId(id)) { next(); return }

    if (parts.length === 3 && parts[1] === "v" && VERSION.test(parts[2]!) && req.method === "GET") {
      const version = Number(parts[2])
      const found = await store().readVersion(id, version)
      if (!(await authorizeView(req, res, found?.record ?? (await store().read(id)), "view"))) return
      if (!found) { sendSessionHidden(res, null); return }
      const body: StoredViewVersion = {
        id: found.record.id,
        title: found.record.title,
        version,
        latestVersion: found.record.versions.at(-1)?.version ?? 0,
        html: found.html,
        files: found.files,
      }
      res.setHeader("Cache-Control", "no-store")
      sendJson(res, 200, body)
      return
    }
    if (parts.length !== 1 || (req.method !== "PATCH" && req.method !== "DELETE")) { next(); return }

    if (!(await authorizeView(req, res, await store().read(id, { includeDeleted: req.method === "DELETE" }), "interact"))) return
    if (req.method === "DELETE") {
      await store().remove(id)
      sendJson(res, 200, { deleted: true })
      return
    }
    withJsonBody<ViewUpdate>(req, res, async (body) => {
      const change: ViewUpdate = {}
      if (body && typeof body === "object") {
        if (typeof body.title === "string") change.title = body.title
        if (typeof body.pinned === "boolean") change.pinned = body.pinned
      }
      try {
        sendJson(res, 200, viewSummary(await store().update(id, change)))
      } catch (error) {
        if (!(error instanceof ViewStoreError)) throw error
        // Deleted while the body arrived: answer as for any missing view.
        if (!(await store().read(id))) sendSessionHidden(res, null)
        else sendJson(res, 400, { error: error.message })
      }
    })
  }))
}
