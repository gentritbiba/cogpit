import type { Plugin } from "vite"
import { loadConfig, getConfig } from "./config"
import { refreshDirs, cleanupProcesses, authMiddleware } from "./helpers"
import { registerConfigRoutes } from "./routes/config"
import { registerProjectRoutes } from "./routes/projects"
import { registerClaudeRoutes } from "./routes/claude"
import { registerClaudeNewRoutes } from "./routes/claude-new"
import { registerClaudeManageRoutes } from "./routes/claude-manage"
import { registerPortRoutes } from "./routes/ports"
import { registerTeamRoutes } from "./routes/teams"
import { registerTeamSessionRoutes } from "./routes/team-session"
import { registerUndoRoutes } from "./routes/undo"
import { registerFileRoutes } from "./routes/files"
import { registerFileWatchRoutes } from "./routes/files-watch"

export function sessionApiPlugin(): Plugin {
  return {
    name: "session-api",
    configureServer(server) {
      // Kill all active child processes when the server shuts down
      server.httpServer?.on("close", () => cleanupProcesses())

      // Load config on startup
      loadConfig().then(() => refreshDirs())

      // Auth middleware (before all routes)
      server.middlewares.use(authMiddleware)

      // Guard middleware: block data APIs when not configured
      server.middlewares.use((req, res, next) => {
        const url = req.url || ""
        // Allow config endpoints through without guard
        if (url.startsWith("/api/config")) return next()
        // Allow non-API requests through (HTML, JS, CSS)
        if (!url.startsWith("/api/")) return next()
        // Block data APIs when not configured
        if (!getConfig()) {
          res.statusCode = 503
          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({ error: "Not configured", code: "NOT_CONFIGURED" }))
          return
        }
        // Refresh dirs from current config
        refreshDirs()
        next()
      })

      const use = server.middlewares.use.bind(server.middlewares)
      registerConfigRoutes(use)
      registerProjectRoutes(use)
      registerClaudeRoutes(use)
      registerClaudeNewRoutes(use)
      registerClaudeManageRoutes(use)
      registerPortRoutes(use)
      registerTeamRoutes(use)
      registerTeamSessionRoutes(use)
      registerUndoRoutes(use)
      registerFileRoutes(use)
      registerFileWatchRoutes(use)
    },
  }
}
