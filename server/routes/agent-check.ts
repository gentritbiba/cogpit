import type { AgentCheckResponse } from "../../shared/contracts/agentCheck"
import { sharedAgentCheck } from "../agents/agentCheck"
import { ConfigRestoreError, restoreReportedConfig } from "../agents/configRepair"
import { sendJson, withJsonBody, type UseFn } from "../http"

/**
 * GET /api/agent-check — for each agent CLI a person installs: whether Cogpit
 * can start it, its version and location, whether it is signed in, and the
 * commands that install it or sign it in. It answers before Cogpit is
 * configured, because the setup screen is built on it.
 *
 * POST /api/agent-check/restore-config `{ path }` — put back the backup that a
 * start which failed over an invalid config file named for `path`.
 */
export function registerAgentCheckRoutes(use: UseFn) {
  use("/api/agent-check", async (req, res, next) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname
    if (req.method === "POST" && pathname === "/restore-config") {
      withJsonBody<{ path?: unknown }>(req, res, async ({ path }) => {
        if (typeof path !== "string") return sendJson(res, 400, { error: "path is required" })
        try {
          sendJson(res, 200, await restoreReportedConfig(path))
        } catch (err) {
          sendJson(res, err instanceof ConfigRestoreError ? err.status : 500, { error: err instanceof Error ? err.message : String(err) })
        }
      })
      return
    }
    if (req.method !== "GET" || pathname !== "/") return next()

    const response: AgentCheckResponse = {
      agents: await sharedAgentCheck(),
      checkedAt: new Date().toISOString(),
    }
    res.setHeader("Cache-Control", "no-store")
    sendJson(res, 200, response)
  })
}
