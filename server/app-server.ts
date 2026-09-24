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
import { apiNotFound } from "./http"
import { answersUnconfigured } from "./lib/configGuard"
import { cleanupProcesses } from "./processRegistry"
import { openResponses } from "./lib/openResponses"
import { initializeAppPlugins } from "./plugins/startup"
import { captureLegacyPluginHost, type LegacyHostClassification } from "./plugins/legacyHost"
import { disposeHubPluginRelay } from "./hub/pluginRelay"
import { refreshDirs } from "./sessionPaths"
import { rejectWebsocketUpgrade } from "./security"
import { describeEditionSuppression, editionAuthz, editionModule, loadEdition } from "./edition"
import { initDeviceRegistry } from "./hub/registry"
import { initShareRegistry } from "./share/registry"
import { handleHubUpgrade } from "./hub/proxy"
import { allRuntimes, isSessionActive } from "./agents/runtimes"
import { initBrowserSupport } from "./browser"
import { PtySessionManager } from "./pty-server"
import { PtyAuthorizationController } from "./pty-authorization"
import { BrowserViewerManager } from "./browser/viewerSocket"
import type { HubMode } from "./routes/hello"

/** How long shutdown still waits on its other steps once one has failed. */
const FAILED_SHUTDOWN_GRACE_MS = 10_000
/** How long shutdown lets open requests finish before ending them, event streams included. */
const OPEN_RESPONSE_GRACE_MS = 1_000

/**
 * Wait for every shutdown step, flush the edition's durable state whether or
 * not one failed, then report the first failure. Once a step fails, a step
 * that never settles holds the flush and the failure back for
 * FAILED_SHUTDOWN_GRACE_MS at most. The grace timer stays ref'd: a hung step
 * with no handle of its own must not let the process exit before the flush.
 */
async function settleThenFlushEdition(steps: readonly Promise<unknown>[]): Promise<void> {
  let failure: { reason: unknown } | undefined
  let grace: ReturnType<typeof setTimeout> | undefined
  const graceOver = new Promise<void>((resolve) => {
    for (const step of steps) {
      step.catch((reason: unknown) => {
        if (failure) return
        failure = { reason }
        grace = setTimeout(resolve, FAILED_SHUTDOWN_GRACE_MS)
      })
    }
  })
  await Promise.race([Promise.allSettled(steps), graceOver])
  clearTimeout(grace)
  try {
    await editionModule().flush()
  } catch (error) {
    failure ??= { reason: error }
  }
  if (failure) throw failure.reason
}

export interface AppServerEnvironment {
  mode: Extract<HubMode, "electron" | "standalone">
  viteDevUrl?: string
  legacyPluginHost?: LegacyHostClassification
  legacyClickUpPath?: string
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
  const legacyHost = environment.legacyPluginHost ?? await captureLegacyPluginHost(userDataDir)
  await loadConfig()
  const configEdition = getConfiguredEditionValue()

  // Edition resolves before any route registers; only the standalone shell can
  // honor a team request, and a suppressed request is logged, never silent.
  await loadEdition({ shell: environment.mode, configEdition })
  const suppression = describeEditionSuppression(process.env, configEdition, environment.mode)
  if (suppression) console.warn(suppression)
  // Loaded ahead of the edition, which may check the registry's file.
  await initShareRegistry(userDataDir)
  // Before any request can authenticate and before anything below can spawn a
  // process: the edition's own stores must open first.
  await editionModule().boot({ dataRoot: getDataRoot() })

  await initDeviceRegistry(userDataDir)
  refreshDirs()
  const pluginManager = await initializeAppPlugins(userDataDir, { legacyHost, legacyClickUpPath: environment.legacyClickUpPath })

  const app = express()
  const httpServer = createServer(app)
  const responses = openResponses()

  app.use(responses.track)
  // Security middleware must precede every route.
  app.use(securityHeaders)
  app.use(bodySizeLimit)
  app.use(authMiddleware)
  app.use(editionAuthz)

  // Block data APIs until configuration exists, while leaving discovery,
  // sign-in and the edition's first-time setup available.
  app.use("/api", (req, res, next) => {
    if (answersUnconfigured(`/api${req.path}`)) return next()
    if (!getConfig()) {
      res.status(503).json({ error: "Not configured", code: "NOT_CONFIGURED" })
      return
    }
    next()
  })

  const use = app.use.bind(app)
  registerApiRoutes(use, { mode: environment.mode })
  app.use("/api", apiNotFound)

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
      // Resolve relative to the declared static root. Passing an absolute path
      // makes Express reject valid builds nested under a hidden directory
      // (for example `.worktrees/.../dist`) as a disallowed dotfile path.
      res.sendFile("index.html", { root: staticDir })
    })
  }

  const wss = new WebSocketServer({ noServer: true })
  const ptyManager = new PtySessionManager(wss)
  const browserWss = new WebSocketServer({ noServer: true })
  const browserManager = new BrowserViewerManager()
  const browserSupport = initBrowserSupport(isSessionActive)
  const ptyAuthorization = new PtyAuthorizationController()
  const upgradedSockets = new Set<Duplex>()

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgradedSockets.add(socket)
    socket.once("close", () => upgradedSockets.delete(socket))

    const url = new URL(req.url || "/", "http://localhost")
    if (handleHubUpgrade(req, socket, head)) {
      // Hub transport upgrades bypass the local WebSocketServers and splice raw
      // sockets, so track the caller's outer sign-in session here as well.
      if (!socket.destroyed && /^\/hub\/[^/]+\/(__pty|__browser)$/.test(url.pathname)) {
        ptyAuthorization.trackHubUpgrade(req, url, socket)
      }
      return
    }
    if (url.pathname === "/__pty" || url.pathname === "/__browser") {
      if (rejectWebsocketUpgrade(req, url, socket)) return
      const transport = url.pathname === "/__pty" ? wss : browserWss
      transport.handleUpgrade(req, socket, head, (ws) => transport.emit("connection", ws, req))
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
  browserWss.on("connection", (ws, req) => {
    ptyAuthorization.handleConnection(ws, req, browserManager.socketFor(req))
  })

  let cleanupPromise: Promise<void> | null = null
  const cleanupRuntime = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      ptyManager.cleanup()
      browserManager.cleanup()
      ptyAuthorization.cleanup()
      for (const client of wss.clients) client.terminate()
      for (const client of browserWss.clients) client.terminate()
      for (const socket of upgradedSockets) socket.destroy()
      upgradedSockets.clear()

      await settleThenFlushEdition([
        pluginManager.close(),
        disposeHubPluginRelay(),
        new Promise<void>((resolve) => wss.close(() => resolve())),
        new Promise<void>((resolve) => browserWss.close(() => resolve())),
        cleanupProcesses(),
        browserSupport.shutdown(),
        ...allRuntimes().map((runtime) => runtime.shutdown()),
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
    // close() waits on every open response; an event stream never finishes
    // by itself. Node alone also drops keep-alive sockets this way.
    const endOpenResponses = setTimeout(() => {
      responses.endAll()
      httpServer.closeAllConnections()
    }, OPEN_RESPONSE_GRACE_MS)
    void serverClosed.finally(() => clearTimeout(endOpenResponses)).catch(() => {})

    // httpServer.close() drains active requests. Flush once more afterwards so
    // a login/config mutation that completed during runtime cleanup cannot be
    // acknowledged without its durable session state reaching disk.
    await settleThenFlushEdition([cleanupRuntime(), serverClosed])
  }

  return { httpServer, dispose }
}
