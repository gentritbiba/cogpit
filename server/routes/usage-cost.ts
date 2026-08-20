/**
 * Raw API cost endpoints.
 *
 * - `GET /api/usage-cost?days=30&tz=<IANA>` — scans the provider CLIs' on-disk
 *   transcripts and returns priced `(day, provider, model)` buckets.
 * - `GET /api/usage-cost/rates` — the LiteLLM model rate table snapshot, for
 *   client-side per-turn pricing.
 */
import { sendJson } from "../http"
import type { UseFn } from "../http"
import { getModelRates, makeWindow, readUsageCostSummary } from "../lib/usageCost/service"

const MAX_WINDOW_DAYS = 365

export function registerUsageCostRoutes(use: UseFn) {
  use("/api/usage-cost/rates", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const { status, fetchedAt, rates } = await getModelRates()
    sendJson(res, 200, {
      status,
      fetchedAt,
      rates: Object.fromEntries(rates),
    })
  })

  use("/api/usage-cost", async (req, res, next) => {
    if (req.method !== "GET") return next()
    // Mounted handlers see the path relative to the mount prefix; anything
    // beyond the root here is a subroute like /rates, handled above.
    const url = new URL(req.url ?? "/", "http://localhost")
    if (url.pathname !== "/" && url.pathname !== "") return next()

    const days = Number(url.searchParams.get("days") ?? "30")
    if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
      sendJson(res, 400, { error: `days must be an integer between 1 and ${MAX_WINDOW_DAYS}` })
      return
    }

    const timeZone = url.searchParams.get("tz") || "UTC"
    const summary = await readUsageCostSummary({
      ...makeWindow(days, timeZone),
      timeZone,
    })
    sendJson(res, 200, summary)
  })
}
