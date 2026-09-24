import { sendJson, type UseFn } from "../http"
import { editionModule, markDecided } from "../edition"

/** Identity for every edition, then the running edition's own routes. */
export function registerEditionRoutes(use: UseFn): void {
  // GET /api/me — who am I and what may the UI show.
  use("/api/me", (req, res, next) => {
    if (req.method !== "GET") return next()
    markDecided(req)
    sendJson(res, 200, editionModule().me(req))
  })
  editionModule().registerRoutes(use)
}
