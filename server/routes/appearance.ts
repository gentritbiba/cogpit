import { parseThemeId } from "../../shared/contracts/appearance"
import { HttpBodyError, readJsonBody, sendJson, type UseFn } from "../http"
import { getHostTheme, setHostTheme } from "../lib/appearance"

/**
 * GET /api/appearance — this machine's theme.
 * PUT /api/appearance `{ theme }` — set it for everyone who opens this machine.
 */
export function registerAppearanceRoutes(use: UseFn) {
  use("/api/appearance", async (req, res, next) => {
    const rest = new URL(req.url || "/", "http://localhost").pathname
    if (rest !== "/" && rest !== "") return next()

    if (req.method === "GET") return sendJson(res, 200, { theme: getHostTheme() })
    if (req.method !== "PUT") return next()

    let body: { theme?: unknown } | null
    try {
      body = await readJsonBody<{ theme?: unknown } | null>(req)
    } catch (error) {
      return sendJson(res, error instanceof HttpBodyError ? error.statusCode : 400, { error: "Invalid JSON body" })
    }
    const theme = parseThemeId(body?.theme)
    if (!theme) return sendJson(res, 400, { error: "theme must name a known theme" })
    try {
      await setHostTheme(theme)
    } catch (error) {
      console.error("[appearance] Could not save the theme:", error)
      return sendJson(res, 500, { error: "Could not save the theme" })
    }
    sendJson(res, 200, { theme })
  })
}
