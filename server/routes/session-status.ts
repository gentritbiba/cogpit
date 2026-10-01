import { sendJson, singlePathParam, type UseFn } from "../http"
import { sendHostError } from "./agentErrors"
import { hostForSession, SESSION_SCOPE_HEADER } from "../sessionHosts"

/**
 * GET /api/session-status/:sessionId — cheap per-session poll for external
 * callers. send-message returns immediately when the SDK query is live, so
 * agents need a way to tell when the turn actually finished; `outcome` folds
 * the runtime's `running` flag, the transcript tail and any pending approval or
 * question into one answer (see `readSessionState`). A session on a hub device
 * is answered by that device.
 */
export function registerSessionStatusRoutes(use: UseFn) {
  use("/api/session-status/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const sessionId = singlePathParam(req)
    if (!sessionId) return next()

    try {
      const host = await hostForSession(sessionId, { localOnly: req.headers[SESSION_SCOPE_HEADER] === "local" })
      const state = await host.state(sessionId)
      if (state.outcome === "not_found") {
        sendJson(res, 404, { error: "Session not found" })
        return
      }
      sendJson(res, 200, state)
    } catch (error) {
      sendHostError(res, error, "Failed to read the session's status")
    }
  })
}
