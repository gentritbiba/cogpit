import { AGENT_KINDS, type AgentKind } from "../../shared/session/agent-descriptors"
import { accountSwitcherFor } from "../agents/accounts"
import { sendJson, withJsonBody, type UseFn } from "../http"

/**
 * GET  /api/agent-accounts/:kind         — logins the agent's switcher manages
 *                                          and which one is live.
 * POST /api/agent-accounts/:kind/switch  — `{ slot }` makes that login live.
 *
 * 404 for agents without a switcher. The body only ever names a slot from the
 * list; the command itself is Cogpit's.
 */
export function registerAgentAccountRoutes(use: UseFn) {
  use("/api/agent-accounts", async (req, res, next) => {
    const segments = new URL(req.url || "/", "http://localhost").pathname.split("/").filter(Boolean)
    const [kind, action, ...rest] = segments
    if (!(AGENT_KINDS as readonly string[]).includes(kind ?? "") || rest.length > 0) return next()
    const switcher = accountSwitcherFor(kind as AgentKind)

    if (action === undefined && req.method === "GET") {
      if (!switcher) {
        sendJson(res, 404, { error: `${kind} has no account switcher` })
        return
      }
      try {
        sendJson(res, 200, await switcher.describe())
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (action === "switch" && req.method === "POST") {
      if (!switcher) {
        sendJson(res, 404, { error: `${kind} has no account switcher` })
        return
      }
      withJsonBody<{ slot?: unknown }>(req, res, async (body) => {
        const slot = body?.slot
        if (typeof slot !== "number" || !Number.isInteger(slot) || slot <= 0) {
          sendJson(res, 400, { error: "slot must be a positive integer" })
          return
        }
        try {
          sendJson(res, 200, await switcher.switchTo(slot))
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        }
      })
      return
    }

    next()
  })
}
