import express from "express"
import { createServer, request as httpRequest } from "node:http"
import { join } from "node:path"
import { WebSocketServer } from "ws"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import { setConfigPath, loadConfig, getConfig } from "../server/config"
import { dirs, refreshDirs, cleanupProcesses, authMiddleware, securityHeaders, bodySizeLimit, isLocalRequest, validateSessionToken } from "../server/helpers"
import { registerConfigRoutes } from "../server/routes/config"
import { registerProjectRoutes } from "../server/routes/projects"
import { registerClaudeRoutes } from "../server/routes/claude"
import { registerClaudeNewRoutes } from "../server/routes/claude-new"
import { registerClaudeManageRoutes } from "../server/routes/claude-manage"
import { registerClaudeRuntimeRoutes } from "../server/routes/claude-runtime"
import { registerPortRoutes } from "../server/routes/ports"
import { registerTeamRoutes } from "../server/routes/teams"
import { registerTeamSessionRoutes } from "../server/routes/team-session"
import { registerWorkflowRoutes } from "../server/routes/workflows"
import { registerUndoRoutes } from "../server/routes/undo"
import { registerFileRoutes } from "../server/routes/files"
import { registerFileWatchRoutes } from "../server/routes/files-watch"
import { registerSessionFileChangesRoutes } from "../server/routes/session-file-changes"
import { registerSessionContextRoutes } from "../server/routes/session-context"
import { registerEditorRoutes } from "../server/routes/editor"
import { registerWorktreeRoutes } from "../server/routes/worktrees"
import { registerUsageRoutes } from "../server/routes/usage"
import { registerSlashSuggestionRoutes } from "../server/routes/slash-suggestions"
import { registerConfigBrowserRoutes } from "../server/routes/config-browser"
import { registerLocalFileRoutes } from "../server/routes/local-file"
import { registerFileContentRoutes } from "../server/routes/file-content"
import { registerMcpRoutes } from "../server/routes/mcp"
import { registerNotifyRoutes } from "../server/routes/notify"
import { registerScriptRoutes } from "../server/routes/scripts"
import { registerPermissionRoutes } from "../server/routes/permissions"
import { registerAskUserRoutes } from "../server/routes/ask-user"
import { registerModelRoutes } from "../server/routes/models"
import { registerCodexRuntimeRoutes } from "../server/routes/codex-runtime"
import { codexAppServer } from "../server/codex-app-server"
import { PtySessionManager } from "../server/pty-server"

// ── Server factory ──────────────────────────────────────────────────
export async function createAppServer(staticDir: string, userDataDir: string) {
  // Configure paths for Electron
  setConfigPath(join(userDataDir, "config.local.json"))
  await loadConfig()
  refreshDirs()
  // Override undo dir to writable location
  dirs.UNDO_DIR = join(userDataDir, "undo-history")

  const app = express()
  const httpServer = createServer(app)

  // ── Security middleware (before all routes) ────────────────────────
  app.use(securityHeaders)
  app.use(bodySizeLimit)
  app.use(authMiddleware)

  // ── Guard middleware ────────────────────────────────────────────
  // Note: refreshDirs() and dirs.UNDO_DIR are set once at startup above (not per-request)
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/config") || req.path.startsWith("/notify")) return next()
    if (!getConfig()) {
      res.status(503).json({ error: "Not configured", code: "NOT_CONFIGURED" })
      return
    }
    next()
  })

  // ── API routes (shared with Vite server) ───────────────────────
  const use = app.use.bind(app)
  registerConfigRoutes(use)
  registerProjectRoutes(use)
  registerClaudeRoutes(use)
  registerClaudeNewRoutes(use)
  registerClaudeManageRoutes(use)
  registerClaudeRuntimeRoutes(use)
  registerPortRoutes(use)
  registerTeamRoutes(use)
  registerTeamSessionRoutes(use)
  registerWorkflowRoutes(use)
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
  registerLocalFileRoutes(use)
  registerFileContentRoutes(use)
  registerMcpRoutes(use)
  registerNotifyRoutes(use)
  registerScriptRoutes(use)
  registerPermissionRoutes(use)
  registerAskUserRoutes(use)
  registerModelRoutes(use)
  registerCodexRuntimeRoutes(use)

  // ── Static files / dev proxy ────────────────────────────────────
  const viteDevUrl = process.env.ELECTRON_RENDERER_URL
  const viteUrl = viteDevUrl ? new URL(viteDevUrl) : null
  if (viteUrl) {
    // Dev mode: proxy non-API requests to Vite dev server (HMR + live CSS)
    app.use((req, res) => {
      const proxyReq = httpRequest(
        { hostname: viteUrl.hostname, port: viteUrl.port, path: req.url, method: req.method, headers: req.headers },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers)
          proxyRes.pipe(res)
        },
      )
      proxyReq.on("error", () => {
        res.status(502).end("Vite dev server not ready")
      })
      req.pipe(proxyReq)
    })
  } else {
    // Production: serve static files + SPA fallback
    app.use(express.static(staticDir))
    app.get("{*path}", (_req, res) => {
      res.sendFile(join(staticDir, "index.html"))
    })
  }

  // ── PTY WebSocket ──────────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true })
  const ptyManager = new PtySessionManager(wss)

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || "/", "http://localhost")
    if (url.pathname === "/__pty") {
      // Auth check for remote WebSocket connections
      if (!isLocalRequest(req)) {
        const cfg = getConfig()
        const token = url.searchParams.get("token")
        if (!cfg?.networkAccess || !cfg?.networkPassword || !token || !validateSessionToken(token)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
          socket.destroy()
          return
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
      return
    }
    // Dev mode: forward HMR WebSocket to Vite dev server
    if (viteUrl) {
      const proxyReq = httpRequest(
        { hostname: viteUrl.hostname, port: viteUrl.port, path: req.url, method: req.method, headers: req.headers },
        (proxyRes) => {
          if (!proxyRes.headers.upgrade) { socket.destroy(); return }
        },
      )
      proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
        socket.write("HTTP/1.1 101 Switching Protocols\r\n" +
          Object.entries(_proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n")
        if (proxyHead.length) socket.write(proxyHead)
        proxySocket.pipe(socket)
        socket.pipe(proxySocket)
      })
      proxyReq.on("error", () => socket.destroy())
      proxyReq.end()
      return
    }
  })

  wss.on("connection", (ws) => ptyManager.handleConnection(ws))

  // ── Cleanup ────────────────────────────────────────────────────
  httpServer.on("close", () => {
    ptyManager.cleanup()
    cleanupProcesses()
    void codexAppServer.shutdown()
  })

  return { httpServer }
}
