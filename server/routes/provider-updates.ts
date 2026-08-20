import { sendJson, withJsonBody, type UseFn } from "../http"
import {
  getProviderUpdates,
  isProviderUpdateId,
  runProviderUpdate,
} from "../lib/providerUpdates"

/**
 * GET  /api/provider-updates      — version advisory for each agent CLI.
 * POST /api/provider-updates/run  — run the upgrade for one provider.
 *
 * The run endpoint only ever executes a command Cogpit derived itself from the
 * binary's install path; the request body picks a provider, never a command.
 */
export function registerProviderUpdateRoutes(use: UseFn) {
  use("/api/provider-updates", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "/", "http://localhost")
    if (url.pathname !== "/") return next()

    try {
      sendJson(res, 200, { providers: await getProviderUpdates() })
    } catch (err) {
      sendJson(res, 500, { error: String(err) })
    }
  })

  use("/api/provider-updates/run", (req, res, next) => {
    if (req.method !== "POST") return next()

    withJsonBody<{ provider?: unknown }>(req, res, async (body) => {
      if (!isProviderUpdateId(body?.provider)) {
        sendJson(res, 400, { error: "provider must be \"claude\" or \"codex\"" })
        return
      }
      try {
        const result = await runProviderUpdate(body.provider)
        sendJson(res, result.status === "failed" ? 500 : 200, result)
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
    })
  })
}
