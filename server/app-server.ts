import { worktreeStartups } from "./sessionStartup/readiness"
import express from "express"
import { createServer, request as httpRequest } from "node:http"
import { join } from "node:path"

import { registerApiRoutes } from "./api-routes"
import { closeCommandDispatcher } from "./lib/durableSend"
import { beginServerStart } from "./lib/installState"
import { closeOrchestrationStore } from "./orchestration/storage"
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
  DEV_DOCUMENT_POLICY,
  desktopSecurityHeaders,
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
import { describeEditionSuppression, editionAuthz, editionModule, loadEdition } from "./edition"
import { initDeviceRegistry } from "./hub/registry"
import { initShareRegistry } from "./share/registry"
import { allRuntimes, isSessionActive } from "./agents/runtimes"
import { initBrowserSupport } from "./browser"
import { installSessionCli } from "./sessionCli/install"
import { resumeLocalDelegations } from "./lib/delegationAuthority"
import { resumeLocalCrewChat } from "./lib/crewChat"
import { startTriggerScheduler, triggerExecutionsSettled } from "./lib/triggers/runner"
import { attachSocketTransports, type UpgradeHandler } from "./socketTransports"
import { startCore } from "./core"
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
  mode: Extract<HubMode, "desktop" | "standalone">
  viteDevUrl?: string
  legacyPluginHost?: LegacyHostClassification
  legacyClickUpPath?: string
  /** The packaged cogpit-core binary; `COGPIT_CORE_BIN` overrides it. */
  coreBin?: string
}

/**
 * Compose the shared HTTP and WebSocket server without depending on an
 * environment-specific entry point. Desktop and standalone adapters own the
 * process/environment decisions and pass the resulting values in here.
 */
export async function createServerComposition(
  staticDir: string,
  userDataDir: string,
  environment: AppServerEnvironment,
) {
  // First, before anything below writes; a standalone start has begun it already.
  await beginServerStart(userDataDir)
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
  let core: Awaited<ReturnType<typeof startCore>>
  try {
    core = await startCore({ coreBin: environment.coreBin, dataDir: userDataDir })
  } catch (error) {
    await pluginManager.close()
    throw error
  }

  const app = express()
  const httpServer = createServer(app)
  const responses = openResponses()

  app.use(responses.track)
  // Security middleware must precede every route.
  app.use(environment.mode === "desktop" ? desktopSecurityHeaders : securityHeaders)
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
    // Vite's documents carry inline scripts, so they get its dev policy.
    app.use((req, res) => {
      res.setHeader("Content-Security-Policy", DEV_DOCUMENT_POLICY)
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

  const browserSupport = initBrowserSupport(isSessionActive)
  installSessionCli()
  resumeLocalDelegations()
  resumeLocalCrewChat()
  startTriggerScheduler()

  // Dev mode: forward Vite's HMR WebSocket. Otherwise nothing else upgrades.
  const viteUpgrade: UpgradeHandler = (req, socket) => {
    if (!viteUrl) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
      return
    }
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
  }
  const transports = attachSocketTransports(httpServer, { fallback: viteUpgrade })

  let cleanupPromise: Promise<void> | null = null
  const cleanupRuntime = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      await settleThenFlushEdition([
        transports.close(),
        pluginManager.close(),
        disposeHubPluginRelay(),
        cleanupProcesses(),
        worktreeStartups.close(),
        browserSupport.shutdown(),
        ...allRuntimes().map((runtime) => runtime.shutdown()),
        core.release(),
      ])
    })()
    return cleanupPromise
  }

  httpServer.on("close", () => {
    closeCommandDispatcher()
    void cleanupRuntime().then(() => triggerExecutionsSettled()).finally(closeOrchestrationStore)
  })

  const dispose = async (): Promise<void> => {
    closeCommandDispatcher()
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
    await triggerExecutionsSettled()
    closeOrchestrationStore()
  }

  return { httpServer, dispose }
}
