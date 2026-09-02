import { getSessionStatus } from "../helpers"
import { storeForPath } from "../agents"
import { runtimeFor } from "../agents/runtimes"
import { findJsonlPath } from "../sessionPaths"
import { sendJson, type UseFn } from "../http"

/**
 * GET /api/session-status/:sessionId — cheap per-session poll for external
 * callers. send-message returns immediately when the SDK query is live, so
 * agents need a way to tell when the turn actually finished: `running` covers
 * sessions this server manages, and the JSONL-tail-derived `status` covers
 * sessions it doesn't (started in a terminal, or before a restart).
 */
export function registerSessionStatusRoutes(use: UseFn) {
  use("/api/session-status/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()

    const sessionId = decodeURIComponent(parts[0])
    try {
      const filePath = await findJsonlPath(sessionId)
      if (!filePath) {
        sendJson(res, 404, { error: "Session not found" })
        return
      }

      // The transcript already told us whose it is, so activity comes from the
      // one runtime that owns the session rather than from an OR across all
      // three — `live` and `running` mean different things to each of them.
      const runtime = runtimeFor(storeForPath(filePath)?.kind ?? "claude")
      const statusInfo = await getSessionStatus(filePath)
      sendJson(res, 200, { sessionId, ...runtime.activity(sessionId), ...statusInfo })
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })
}
