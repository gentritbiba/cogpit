import {
  activeProcesses,
  persistentSessions,
  findJsonlPath,
  getSessionStatus,
} from "../helpers"
import { sendJson, type UseFn } from "../http"
import { sdkSessions, isSDKQueryLive } from "../sdk-session"
import { codexAppServer } from "../codex-app-server"

/**
 * In-memory session activity. `live`: the server holds an open query/process
 * that can take follow-ups without a resume (stays true between turns for SDK
 * and legacy sessions). `running`: a turn is in flight right now — set before
 * send-message responds and cleared at the turn boundary, so it is the
 * authoritative completion signal for server-managed sessions, unlike the
 * tail-derived `status`, which lags until the CLI flushes the new turn's JSONL.
 */
function getSessionActivity(sessionId: string): { live: boolean; running: boolean } {
  const sdk = sdkSessions.get(sessionId)
  const persistent = persistentSessions.get(sessionId)
  const codexTurnActive = codexAppServer.getActiveTurnId(sessionId) !== undefined
  return {
    live: isSDKQueryLive(sdk) || Boolean(persistent && !persistent.dead) || codexTurnActive,
    running: sdk?.running === true || activeProcesses.has(sessionId) || codexTurnActive,
  }
}

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

      const statusInfo = await getSessionStatus(filePath)
      sendJson(res, 200, { sessionId, ...getSessionActivity(sessionId), ...statusInfo })
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })
}
