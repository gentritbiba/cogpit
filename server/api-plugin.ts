import type { Plugin } from "vite"
import { loadConfig, getConfig } from "./config"
import { resolveSearchIndexPath } from "./lib/searchIndexPath"
import { dirs, refreshDirs, cleanupProcesses, authMiddleware, securityHeaders, bodySizeLimit } from "./helpers"
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
import { registerSessionFileChangesRoutes } from "./routes/session-file-changes"
import { registerSessionContextRoutes } from "./routes/session-context"
import { registerEditorRoutes } from "./routes/editor"
import { registerWorktreeRoutes } from "./routes/worktrees"
import { registerUsageRoutes } from "./routes/usage"
import { registerSlashSuggestionRoutes } from "./routes/slash-suggestions"
import { registerConfigBrowserRoutes } from "./routes/config-browser"
import { registerSessionSearchRoutes, setSearchIndex, getSearchIndex } from "./routes/session-search"
import { registerLocalFileRoutes } from "./routes/local-file"
import { registerFileContentRoutes } from "./routes/file-content"
import { registerSearchIndexRoutes } from "./routes/search-index-stats"
import { registerCogpitSearchRoutes } from "./routes/cogpit-search"
import { registerMcpRoutes } from "./routes/mcp"
import { registerNotifyRoutes } from "./routes/notify"
import { registerScriptRoutes } from "./routes/scripts"
import { registerPermissionRoutes } from "./routes/permissions"
import { SearchIndex } from "./search-index"
import { invalidateSessionMeta } from "./lib/sessionMetaCache"

export function sessionApiPlugin(): Plugin {
  return {
    name: "session-api",
    configureServer(server) {
      // Kill all active child processes when the server shuts down
      server.httpServer?.on("close", () => {
        cleanupProcesses()
        const index = getSearchIndex()
        if (index) {
          index.stopWatching()
          index.close()
        }
      })

      // Load config on startup, then boot search index
      loadConfig().then(async () => {
        refreshDirs()
        // Boot search index after dirs are ready
        try {
          const dbPath = resolveSearchIndexPath()
          const index = new SearchIndex(dbPath)
          index.onFileChanged = invalidateSessionMeta
          setSearchIndex(index)
          // startWatching does async I/O (updateStale) before setting up fs.watch
          if (dirs.PROJECTS_DIR) await index.startWatching(dirs.PROJECTS_DIR)
        } catch (err) {
          console.warn("[search-index] Failed to boot search index:", err)
        }
      })

      // Security middleware (before all routes)
      server.middlewares.use(securityHeaders)
      server.middlewares.use(bodySizeLimit)
      server.middlewares.use(authMiddleware)

      // Guard middleware: block data APIs when not configured
      server.middlewares.use((req, res, next) => {
        const url = req.url || ""
        // Allow config endpoints through without guard
        if (url.startsWith("/api/config") || url.startsWith("/api/notify")) return next()
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
      registerSessionFileChangesRoutes(use)
      registerSessionContextRoutes(use)
      registerEditorRoutes(use)
      registerWorktreeRoutes(use)
      registerUsageRoutes(use)
      registerSlashSuggestionRoutes(use)
      registerConfigBrowserRoutes(use)
      registerSessionSearchRoutes(use)
      registerLocalFileRoutes(use)
      registerFileContentRoutes(use)
      registerSearchIndexRoutes(use)
      registerCogpitSearchRoutes(use)
      registerMcpRoutes(use)
      registerNotifyRoutes(use)
      registerScriptRoutes(use)
      registerPermissionRoutes(use)
    },
  }
}
