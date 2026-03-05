import type { UseFn } from "../helpers"
import { sendJson } from "../helpers"
import { getSearchIndex } from "./session-search"

export function registerSearchIndexRoutes(use: UseFn) {
  use("/api/search-index/stats", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const index = getSearchIndex()
    if (!index) {
      return sendJson(res, 503, { error: "Search index not available" })
    }

    sendJson(res, 200, index.getStats())
  })

  use("/api/search-index/rebuild", async (req, res, next) => {
    if (req.method !== "POST") return next()

    const index = getSearchIndex()
    if (!index) {
      return sendJson(res, 503, { error: "Search index not available" })
    }

    // Respond immediately — rebuild runs in the next tick so the response is flushed first
    sendJson(res, 200, { status: "rebuilding" })

    setTimeout(() => {
      try {
        index.rebuild()
      } catch {
        // Non-fatal — index will recover on next update
      }
    }, 0)
  })
}
