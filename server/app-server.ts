import express from "express"
import { createServer, request as httpRequest } from "node:http"
import { join } from "node:path"
import { WebSocketServer } from "ws"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import { registerApiRoutes } from "./api-routes"
import { setConfigPath, loadConfig, getConfig } from "./config"
import {
  authMiddleware,
  securityHeaders,
  bodySizeLimit,
} from "./helpers"
import { cleanupProcesses } from "./processRegistry"
import { dirs, refreshDirs } from "./sessionPaths"
import { websocketUpgradeRejection } from "./security"
import { initDeviceRegistry } from "./hub/registry"
import { handleHubUpgrade } from "./hub/proxy"
import { codexAppServer } from "./codex-app-server"
import { PtySessionManager } from "./pty-server"
import type { HubMode } from "./routes/hello"

export interface AppServerEnvironment {
  mode: Extract<HubMode, "electron" | "standalone">
  viteDevUrl?: string
}

/**
 * Compose the shared HTTP and WebSocket server without depending on an
 * environment-specific entry point. Electron and standalone adapters own the
 * process/environment decisions and pass the resulting values in here.
 */
export async function createServerComposition(
  staticDir: string,
  userDataDir: string,
  environment: AppServerEnvironment,
) {
  setConfigPath(join(userDataDir, "config.local.json"))
  await loadConfig()
  await initDeviceRegistry(userDataDir)
  refreshDirs()
  dirs.UNDO_DIR = join(userDataDir, "undo-history")

  const app = express()
  const httpServer = createServer(app)

  // Security middleware must precede every route.
  app.use(securityHeaders)
  app.use(bodySizeLimit)
  app.use(authMiddleware)

  // Block data APIs until configuration exists, while leaving bootstrap and
  // discovery endpoints available.
  app.use("/api", (req, res, next) => {
    if (
      req.path.startsWith("/config")
      || req.path.startsWith("/notify")
      || req.path.startsWith("/hello")
    ) return next()
    if (!getConfig()) {
      res.status(503).json({ error: "Not configured", code: "NOT_CONFIGURED" })
      return
    }
    next()
  })

  const use = app.use.bind(app)
  registerApiRoutes(use, { mode: environment.mode })

  const viteUrl = environment.viteDevUrl
    ? new URL(environment.viteDevUrl)
    : null
  if (viteUrl) {
    // Dev mode: proxy non-API requests to Vite (including live CSS/HMR HTTP).
    app.use((req, res) => {
      const proxyReq = httpRequest(
        {
          hostname: viteUrl.hostname,
          port: viteUrl.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
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
    app.use(express.static(staticDir))
    app.get("{*path}", (_req, res) => {
      res.sendFile(join(staticDir, "index.html"))
    })
  }

  const wss = new WebSocketServer({ noServer: true })
  const ptyManager = new PtySessionManager(wss)
  const upgradedSockets = new Set<Duplex>()

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgradedSockets.add(socket)
    socket.once("close", () => upgradedSockets.delete(socket))

    if (handleHubUpgrade(req, socket, head)) return
    const url = new URL(req.url || "/", "http://localhost")
    if (url.pathname === "/__pty") {
      const rejection = websocketUpgradeRejection(req, url)
      if (rejection) {
        const reason = rejection === 401 ? "Unauthorized" : "Forbidden"
        socket.write(`HTTP/1.1 ${rejection} ${reason}\r\n\r\n`)
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
      return
    }
    // Dev mode: forward Vite's HMR WebSocket.
    if (viteUrl) {
      const proxyReq = httpRequest(
        {
          hostname: viteUrl.hostname,
          port: viteUrl.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (proxyRes) => {
          if (!proxyRes.headers.upgrade) {
            socket.destroy()
          }
        },
      )
      proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n"
          + Object.entries(_proxyRes.headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\r\n")
          + "\r\n\r\n",
        )
        if (proxyHead.length) socket.write(proxyHead)
        proxySocket.pipe(socket)
        socket.pipe(proxySocket)
      })
      proxyReq.on("error", () => socket.destroy())
      proxyReq.end()
      return
    }

    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
  })

  wss.on("connection", (ws) => ptyManager.handleConnection(ws))

  let cleanupPromise: Promise<void> | null = null
  const cleanupRuntime = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      ptyManager.cleanup()
      for (const client of wss.clients) client.terminate()
      for (const socket of upgradedSockets) socket.destroy()
      upgradedSockets.clear()

      await Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        cleanupProcesses(),
        codexAppServer.shutdown(),
      ])
    })()
    return cleanupPromise
  }

  httpServer.on("close", () => {
    void cleanupRuntime()
  })

  const dispose = async (): Promise<void> => {
    const serverClosed = httpServer.listening
      ? new Promise<void>((resolve, reject) => {
          httpServer.close((error) => error ? reject(error) : resolve())
        })
      : Promise.resolve()

    await cleanupRuntime()
    await serverClosed
  }

  return { httpServer, dispose }
}
