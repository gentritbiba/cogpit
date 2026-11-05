import type { UseFn } from "../http"
import { VIEW_SHELL_HEADERS, VIEW_SHELL_HTML } from "../views/shell"

/** Serves the sandbox an agent's interactive view renders in; it carries no data of its own. */
export function registerViewRoutes(use: UseFn): void {
  use("/api/views", (req, res, next) => {
    const path = (req.url ?? "/").split("?")[0]
    if (req.method !== "GET" || path !== "/shell/v1") { next(); return }
    for (const [name, value] of Object.entries(VIEW_SHELL_HEADERS)) res.setHeader(name, value)
    res.end(VIEW_SHELL_HTML)
  })
}
