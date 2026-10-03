import { SESSION_ACCESS_PATH, type SessionAccessLookup } from "../../shared/contracts/sessionAccess"
import { accessLevelOf, authorizeSession, sendSessionHidden } from "../edition"
import { sendJson, type UseFn } from "../http"

/**
 * GET /api/session-access/:sessionId — the caller's level on one session, for
 * a client that learns what it may do there before it offers the controls.
 * A session the caller cannot see is answered like any hidden session.
 */
export function registerSessionAccessRoutes(use: UseFn): void {
  use(SESSION_ACCESS_PATH, async (req, res, next) => {
    if (req.method !== "GET") return next()
    const parts = new URL(req.url || "/", "http://localhost").pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()

    let sessionId: string
    try {
      sessionId = decodeURIComponent(parts[0])
    } catch {
      return next()
    }
    const session = await authorizeSession(req, res, { sessionId }, "view")
    if (session === null) return
    const level = await accessLevelOf(req, session.sessionId)
    if (level === null) {
      sendSessionHidden(res, session.sessionId)
      return
    }
    const lookup: SessionAccessLookup = { sessionId: session.sessionId, level }
    sendJson(res, 200, lookup)
  })
}
