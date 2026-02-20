import express from "express"
import { createServer, request as httpRequest } from "node:http"
import { join } from "node:path"
import { WebSocketServer, WebSocket } from "ws"
import { spawn as ptySpawn, type IPty } from "node-pty"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import { setConfigPath, loadConfig, getConfig } from "../server/config"
import { dirs, refreshDirs, cleanupProcesses, authMiddleware, securityHeaders, bodySizeLimit, isLocalRequest, validateSessionToken } from "../server/helpers"
import { registerConfigRoutes } from "../server/routes/config"
import { registerProjectRoutes } from "../server/routes/projects"
import { registerClaudeRoutes } from "../server/routes/claude"
import { registerClaudeNewRoutes } from "../server/routes/claude-new"
import { registerClaudeManageRoutes } from "../server/routes/claude-manage"
import { registerPortRoutes } from "../server/routes/ports"
import { registerTeamRoutes } from "../server/routes/teams"
import { registerTeamSessionRoutes } from "../server/routes/team-session"
import { registerUndoRoutes } from "../server/routes/undo"
import { registerFileRoutes } from "../server/routes/files"
import { registerFileWatchRoutes } from "../server/routes/files-watch"
import { registerSessionFileChangesRoutes } from "../server/routes/session-file-changes"
import { registerEditorRoutes } from "../server/routes/editor"

// ── PTY types ───────────────────────────────────────────────────────
interface PtySession {
  id: string
  pty: IPty
  name: string
  status: "running" | "exited"
  exitCode: number | null
  cols: number
  rows: number
  scrollback: string
  clients: Set<WebSocket>
  createdAt: number
  cwd: string
}

function toSessionInfo(s: PtySession) {
  return { id: s.id, name: s.name, status: s.status, exitCode: s.exitCode, createdAt: s.createdAt, cwd: s.cwd }
}

function broadcastToAll(wss: WebSocketServer, msg: object) {
  const data = JSON.stringify(msg)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data)
  }
}

function sendSessionList(wss: WebSocketServer, sessions: Map<string, PtySession>) {
  broadcastToAll(wss, { type: "sessions", sessions: Array.from(sessions.values()).map(toSessionInfo) })
}

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
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/config")) return next()
    if (!getConfig()) {
      res.status(503).json({ error: "Not configured", code: "NOT_CONFIGURED" })
      return
    }
    refreshDirs()
    dirs.UNDO_DIR = join(userDataDir, "undo-history")
    next()
  })

  // ── API routes (shared with Vite server) ───────────────────────
  const use = app.use.bind(app)
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
  registerEditorRoutes(use)

  // ── Static files / dev proxy ────────────────────────────────────
  const viteDevUrl = process.env.ELECTRON_RENDERER_URL
  if (viteDevUrl) {
    // Dev mode: proxy non-API requests to Vite dev server (HMR + live CSS)
    const vite = new URL(viteDevUrl)
    app.use((req, res) => {
      const proxyReq = httpRequest(
        { hostname: vite.hostname, port: vite.port, path: req.url, method: req.method, headers: req.headers },
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
  const ptySessions = new Map<string, PtySession>()
  const wss = new WebSocketServer({ noServer: true })

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
    if (viteDevUrl) {
      const vite = new URL(viteDevUrl)
      const proxyReq = httpRequest(
        { hostname: vite.hostname, port: vite.port, path: req.url, method: req.method, headers: req.headers },
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

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        handleMessage(ws, msg)
      } catch {
        ws.send(JSON.stringify({ type: "error", id: "", message: "Invalid JSON" }))
      }
    })
    ws.on("close", () => {
      for (const session of ptySessions.values()) session.clients.delete(ws)
    })
  })

  function handleMessage(ws: WebSocket, msg: Record<string, unknown>) {
    switch (msg.type) {
      case "spawn": handleSpawn(ws, msg); break
      case "input": handleInput(msg); break
      case "resize": handleResize(msg); break
      case "kill": handleKill(msg); break
      case "attach": handleAttach(ws, msg); break
      case "list":
        ws.send(JSON.stringify({ type: "sessions", sessions: Array.from(ptySessions.values()).map(toSessionInfo) }))
        break
      case "rename": handleRename(msg); break
    }
  }

  function handleSpawn(ws: WebSocket, msg: Record<string, unknown>) {
    const id = (msg.id as string) || randomUUID()
    const name = (msg.name as string) || `Terminal ${ptySessions.size + 1}`
    const cwd = (msg.cwd as string) || homedir()
    const cols = (msg.cols as number) || 80
    const rows = (msg.rows as number) || 24
    const command = (msg.command as string) || process.env.SHELL || "/bin/zsh"
    const args = (msg.args as string[]) || []

    let pty: IPty
    try {
      pty = ptySpawn(command, args, {
        name: "xterm-256color", cols, rows, cwd,
        env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
      })
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", id, message: `Failed to spawn PTY: ${err}` }))
      return
    }

    const session: PtySession = { id, pty, name, status: "running", exitCode: null, cols, rows, scrollback: "", clients: new Set([ws]), createdAt: Date.now(), cwd }

    pty.onData((data: string) => {
      session.scrollback += data
      if (session.scrollback.length > 50_000) session.scrollback = session.scrollback.slice(-40_000)
      const out = JSON.stringify({ type: "output", id, data })
      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(out)
      }
    })

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = "exited"
      session.exitCode = exitCode
      const exitMsg = JSON.stringify({ type: "exit", id, code: exitCode })
      for (const client of session.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(exitMsg)
      }
      sendSessionList(wss, ptySessions)
    })

    ptySessions.set(id, session)
    ws.send(JSON.stringify({ type: "spawned", id, name }))
    sendSessionList(wss, ptySessions)
  }

  function handleInput(msg: Record<string, unknown>) {
    const session = ptySessions.get(msg.id as string)
    if (session?.status === "running") session.pty.write(msg.data as string)
  }

  function handleResize(msg: Record<string, unknown>) {
    const session = ptySessions.get(msg.id as string)
    if (session?.status === "running") {
      session.pty.resize(msg.cols as number, msg.rows as number)
      session.cols = msg.cols as number
      session.rows = msg.rows as number
    }
  }

  function handleKill(msg: Record<string, unknown>) {
    const session = ptySessions.get(msg.id as string)
    if (session) {
      if (session.status === "running") session.pty.kill()
      ptySessions.delete(msg.id as string)
      sendSessionList(wss, ptySessions)
    }
  }

  function handleAttach(ws: WebSocket, msg: Record<string, unknown>) {
    const session = ptySessions.get(msg.id as string)
    if (!session) {
      ws.send(JSON.stringify({ type: "error", id: msg.id, message: "Session not found" }))
      return
    }
    session.clients.add(ws)
    if (session.scrollback.length > 0) ws.send(JSON.stringify({ type: "output", id: msg.id, data: session.scrollback }))
    if (session.status === "exited") ws.send(JSON.stringify({ type: "exit", id: msg.id, code: session.exitCode }))
  }

  function handleRename(msg: Record<string, unknown>) {
    const session = ptySessions.get(msg.id as string)
    if (session) {
      session.name = msg.name as string
      sendSessionList(wss, ptySessions)
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────
  httpServer.on("close", () => {
    for (const session of ptySessions.values()) {
      if (session.status === "running") session.pty.kill()
    }
    ptySessions.clear()
    cleanupProcesses()
  })

  return { httpServer }
}
