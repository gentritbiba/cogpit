import { allRuntimes } from "../agents/runtimes"
import { sendJson, type UseFn } from "../http"

/**
 * `GET /api/<cli>/runtime` — one route per agent, generated from the registry.
 *
 * The three snapshots stay in their own wire shapes on purpose: they report
 * different things (plan usage, rate limits, a quota), external clients read
 * them, and pretending they were one shape would mean inventing fields no CLI
 * actually answers. What is shared is everything around them — the path, the
 * `?refresh=1` flag, and what a failure looks like.
 *
 * A runtime that can describe its own unavailability answers 200 with
 * `available: false`; one that cannot reports a 502.
 */
export function registerAgentRuntimeRoutes(use: UseFn): void {
  for (const runtime of allRuntimes()) {
    use(`/api/${runtime.descriptor.binName}/runtime`, (req, res, next) => {
      if (req.method !== "GET") return next()
      const url = new URL(req.url ?? "/", "http://localhost")
      if (url.pathname !== "/" && url.pathname !== "") return next()

      void runtime.describeRuntime(url.searchParams.get("refresh") === "1").then(
        (snapshot) => { sendJson(res, 200, snapshot as Record<string, unknown>) },
        (error) => {
          sendJson(res, 502, {
            available: false,
            error: error instanceof Error
              ? error.message
              : `${runtime.descriptor.displayName} runtime unavailable`,
          })
        },
      )
    })
  }
}
