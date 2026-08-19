import type { Plugin } from "vite"
import { fileURLToPath } from "node:url"
import { registerApiRoutes } from "./api-routes"
import { getConfiguredEditionValue, loadConfig, getConfig } from "./config"
import { authMiddleware, securityHeaders, bodySizeLimit } from "./helpers"
import { prefixMatches } from "./http"
import { cleanupProcesses } from "./processRegistry"
import { refreshDirs } from "./sessionPaths"
import { teamAuthzMiddleware } from "./team/authz"
import { describeEditionSuppression, initEdition } from "./team/edition"
import { initDeviceRegistry } from "./hub/registry"
import { codexAppServer } from "./codex-app-server"

export function sessionApiPlugin(): Plugin {
  return {
    name: "session-api",
    async configureServer(server) {
      // Kill all active child processes when the server shuts down
      server.httpServer?.on("close", () => {
        void Promise.all([
          cleanupProcesses(),
          codexAppServer.shutdown(),
        ])
      })

      // Vite awaits async configureServer hooks. Complete initialization before
      // registering middleware so the first request observes the same ready
      // config/registry state as Electron and standalone composition.
      await Promise.all([
        loadConfig(),
        initDeviceRegistry(fileURLToPath(new URL("..", import.meta.url))),
      ])
      refreshDirs()
      const configEdition = getConfiguredEditionValue()

      // The dev shell always resolves personal (team is standalone-only), but
      // a team request must still be visibly suppressed, never silently eaten.
      initEdition({ shell: "dev", configEdition })
      const suppression = describeEditionSuppression(process.env, configEdition, "dev")
      if (suppression) console.warn(suppression)

      // Security middleware (before all routes)
      server.middlewares.use(securityHeaders)
      server.middlewares.use(bodySizeLimit)
      server.middlewares.use(authMiddleware)
      // Parity with app-server: a no-op here since the dev shell is always
      // personal edition, but the middleware order stays identical.
      server.middlewares.use(teamAuthzMiddleware)

      // Guard middleware: block data APIs when not configured
      server.middlewares.use((req, res, next) => {
        const url = req.url || ""
        // Allow config/identity/bootstrap endpoints through without guard
        const exempt = [
          "/api/config",
          "/api/hello",
          "/api/me",
          "/api/team/bootstrap",
          "/api/auth",
        ]
        if (exempt.some((prefix) => prefixMatches(url, prefix))) return next()
        // Allow non-API requests through (HTML, JS, CSS)
        if (!url.startsWith("/api/")) return next()
        // Block data APIs when not configured
        if (!getConfig()) {
          res.statusCode = 503
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Not configured", code: "NOT_CONFIGURED" }))
          return
        }
        next()
      })

      const use = server.middlewares.use.bind(server.middlewares)
      registerApiRoutes(use, { mode: "dev" })
    },
  }
}
