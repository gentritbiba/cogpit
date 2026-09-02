import { AGENT_KINDS, type AgentKind } from "../../shared/session/agent-descriptors"
import { describeExecutableFor } from "../agents/executables"
import { sendJson, type UseFn } from "../http"

/**
 * GET /api/agent-executable/:kind — the binaries Cogpit could spawn for one
 * agent, their versions, and the one the current setting resolves to. 404 for
 * agents that have no choice to make.
 */
export function registerAgentExecutableRoutes(use: UseFn) {
  use("/api/agent-executable", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const kind = new URL(req.url || "/", "http://localhost").pathname.slice(1)
    if (!(AGENT_KINDS as readonly string[]).includes(kind)) return next()

    const report = describeExecutableFor(kind as AgentKind)
    if (!report) {
      sendJson(res, 404, { error: `${kind} has a single executable; nothing to choose` })
      return
    }
    try {
      sendJson(res, 200, await report)
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })
}
