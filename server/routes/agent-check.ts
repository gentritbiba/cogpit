import type { AgentCheckResponse } from "../../shared/contracts/agentCheck"
import { checkAgents } from "../agents/agentCheck"
import { sendJson, type UseFn } from "../http"

/**
 * GET /api/agent-check — for each agent CLI a person installs: whether Cogpit
 * can start it, its version and location, whether it is signed in, and the
 * commands that install it or sign it in. It answers before Cogpit is
 * configured, because the setup screen is built on it.
 */
export function registerAgentCheckRoutes(use: UseFn) {
  use("/api/agent-check", async (req, res, next) => {
    if (req.method !== "GET") return next()
    if (new URL(req.url || "/", "http://localhost").pathname !== "/") return next()

    const response: AgentCheckResponse = {
      agents: await checkAgents(),
      checkedAt: new Date().toISOString(),
    }
    res.setHeader("Cache-Control", "no-store")
    sendJson(res, 200, response)
  })
}
