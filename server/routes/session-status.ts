import { readSessionState } from "../lib/sessionWait"
import { sendJson, type UseFn } from "../http"

/**
 * GET /api/session-status/:sessionId — cheap per-session poll for external
 * callers. send-message returns immediately when the SDK query is live, so
 * agents need a way to tell when the turn actually finished; `outcome` folds
 * the runtime's `running` flag, the transcript tail and any pending approval or
 * question into one answer (see `readSessionState`).
 */
export function registerSessionStatusRoutes(use: UseFn) {
  use("/api/session-status/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()

    try {
      const state = await readSessionState(decodeURIComponent(parts[0]))
      if (state.outcome === "not_found") {
        sendJson(res, 404, { error: "Session not found" })
        return
      }
      sendJson(res, 200, state)
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })
}
