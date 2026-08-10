import express from "express"
import { createServer, request as httpRequest } from "node:http"
import { join } from "node:path"
import { WebSocketServer } from "ws"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import { registerApiRoutes } from "./api-routes"
import {
  setConfigPath,
  setDataRoot,
  loadConfig,
  getConfig,
  getConfiguredEditionValue,
  getDataRoot,
} from "./config"
import {
  authMiddleware,
  securityHeaders,
  bodySizeLimit,
} from "./helpers"
import { prefixMatches } from "./http"
import { cleanupProcesses } from "./processRegistry"
import { refreshDirs } from "./sessionPaths"
import { rejectWebsocketUpgrade } from "./security"
import { teamAuthzMiddleware } from "./team/authz"
import { describeEditionSuppression, initEdition, isTeamEdition } from "./team/edition"
import { flushSessionPersistence, initSessionPersistence } from "./team/sessionPersistence"
import { initUsersStore, userCount } from "./team/users"
import { initializeBootstrapToken } from "./team/bootstrapToken"
import { initDeviceRegistry } from "./hub/registry"
import { handleHubUpgrade } from "./hub/proxy"
import { codexAppServer } from "./codex-app-server"
import { PtySessionManager } from "./pty-server"
import { PtyAuthorizationController } from "./pty-authorization"
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
  // The app bundle is read-only, so everything Cogpit writes for itself lives
  // under the user-data directory. Setting the root before refreshDirs() keeps
  // those paths correct across later config reloads.
  setDataRoot(userDataDir)
  setConfigPath(join(userDataDir, "config.local.json"))
  await loadConfig()
  const configEdition = getConfiguredEditionValue()

  // Edition resolves before any route registers; only the standalone shell can
  // honor a team request, and a suppressed request is logged, never silent.
  initEdition({ shell: environment.mode, configEdition })
  const suppression = describeEditionSuppression(process.env, configEdition, environment.mode)
  if (suppression) console.warn(suppression)

  if (isTeamEdition()) {
    // Users must load before any request can authenticate, sessions before any
    // login can persist. A corrupt users store rejects here on purpose: booting
    // with an empty list would reopen the unauthenticated first-admin
    // bootstrap, so the shell must die loudly instead.
    const teamDir = join(getDataRoot(), "team")
    await initUsersStore(teamDir)
    await initSessionPersistence(teamDir)
    initializeBootstrapToken(userCount())
  }

  await initDeviceRegistry(userDataDir)
  refreshDirs()

  const app = express()
  const httpServer = createServer(app)

  // Security middleware must precede every route.
  app.use(securityHeaders)
  app.use(bodySizeLimit)
  app.use(authMiddleware)
  app.use(teamAuthzMiddleware)

  // Block data APIs until configuration exists, while leaving bootstrap and
  // discovery endpoints available.
  app.use("/api", (req, res, next) => {
    const exempt = ["/config", "/notify", "/hello", "/me", "/team/bootstrap", "/auth"]
    if (exempt.some((prefix) => prefixMatches(req.path, prefix))) return next()
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
  const ptyAuthorization = new PtyAuthorizationController()
  const upgradedSockets = new Set<Duplex>()

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgradedSockets.add(socket)
    socket.once("close", () => upgradedSockets.delete(socket))

    const url = new URL(req.url || "/", "http://localhost")
    if (handleHubUpgrade(req, socket, head)) {
      // Hub PTY upgrades bypass the local WebSocketServer and splice raw
      // sockets, so track the caller's outer team session here as well.
      if (!socket.destroyed && /^\/hub\/[^/]+\/__pty$/.test(url.pathname)) {
        ptyAuthorization.trackHubUpgrade(req, url, socket)
      }
      return
    }
    if (url.pathname === "/__pty") {
      if (rejectWebsocketUpgrade(req, url, socket)) return
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

  wss.on("connection", (ws, req) => ptyAuthorization.handleConnection(ws, req, ptyManager))

  let cleanupPromise: Promise<void> | null = null
  const cleanupRuntime = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      ptyManager.cleanup()
      ptyAuthorization.cleanup()
      for (const client of wss.clients) client.terminate()
      for (const socket of upgradedSockets) socket.destroy()
      upgradedSockets.clear()

      await Promise.all([
        new Promise<void>((resolve) => wss.close(() => resolve())),
        cleanupProcesses(),
        codexAppServer.shutdown(),
        flushSessionPersistence(),
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
    // httpServer.close() drains active requests. Flush once more afterwards so
    // a login/config mutation that completed during runtime cleanup cannot be
    // acknowledged without its durable session state reaching disk.
    await flushSessionPersistence()
  }

  return { httpServer, dispose }
}
