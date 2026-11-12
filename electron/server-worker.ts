/**
 * Server worker — runs the Express API server in an Electron utilityProcess
 * so that its work (agent runtimes, child processes, cogpit-core, which runs
 * the terminals) never blocks the main process event loop or freezes the UI.
 */
import { CLICKUP_CONFIG_FILE } from "../server/lib/clickupConfig"
import { createServerComposition } from "../server/app-server"
import { getConfig } from "../server/config"
import { detachFromParentCogpit } from "../server/lib/parentCogpit"
import { removePortFile, setServerPort, writePortFile } from "../server/lib/portFile"
import { setDesktopAttention } from "../server/lib/desktopAttention"
import { startSessionActivityMonitor } from "../server/lib/sessionActivityMonitor"
import { startDelegatedRequestWatcher } from "../server/sessionHosts/delegatedRequests"
import { startSlack } from "../server/slack"
import { flushSessionCatalog, startSessionCatalogAfterFirstResponse } from "../server/sessionCatalog"
import { LOCAL_READER, markNotificationsRead } from "../server/lib/notificationHistory"
import { isDesktopAttentionMessage, isNotificationClickedMessage } from "../shared/notifications"

interface WorkerConfig {
  staticDir: string
  userDataDir: string
  isDev: boolean
  /**
   * The app's own cogpit-core. Passed here rather than as COGPIT_CORE_BIN so
   * agents and terminals the server starts do not inherit it.
   */
  coreBin?: string
}

let starting = false

async function start({ staticDir, userDataDir, isDev, coreBin }: WorkerConfig): Promise<void> {
  try {
    detachFromParentCogpit()
    const { httpServer } = await createServerComposition(staticDir, userDataDir, {
      mode: "electron",
      legacyClickUpPath: CLICKUP_CONFIG_FILE,
      viteDevUrl: process.env.ELECTRON_RENDERER_URL,
      coreBin,
    })

    const config = getConfig()
    const networkEnabled = config?.networkAccess && config?.networkPassword
    const listenHost = networkEnabled ? "0.0.0.0" : "127.0.0.1"
    const listenPort = (isDev || networkEnabled) ? 19384 : 0

    startSessionCatalogAfterFirstResponse(httpServer)
    await new Promise<void>((resolve) => {
      httpServer.listen(listenPort, listenHost, () => resolve())
    })

    const address = httpServer.address()
    const port = typeof address === "object" && address ? address.port : 0

    if (!port) {
      process.parentPort.postMessage({ type: "error", error: "Failed to bind port" })
      return
    }

    // Published so agent hooks can find us even on an ephemeral port. Removed on
    // exit so a hook can never POST session text to whatever process inherits
    // that port after Cogpit quits.
    setServerPort(port)
    writePortFile(port)
    process.on("exit", removePortFile)
    // The app ends the worker with SIGTERM on quit; keep what the session catalog learned.
    process.once("SIGTERM", () => { void flushSessionCatalog().finally(() => process.exit(0)) })

    console.log(`[server-worker] Cogpit server listening on http://${listenHost}:${port}`)
    startSessionActivityMonitor()
    startDelegatedRequestWatcher()
    startSlack()
    process.parentPort.postMessage({ type: "ready", port })
  } catch (err) {
    console.error("[server-worker] Failed to start server:", err)
    process.parentPort.postMessage({ type: "error", error: String(err) })
  }
}

process.parentPort.on("message", ({ data }: { data: unknown }) => {
  // The main process reports window focus on this same channel, so every
  // message must be dispatched by shape — not assumed to be the boot config.
  if (isDesktopAttentionMessage(data)) {
    setDesktopAttention(data.attended)
    return
  }

  if (isNotificationClickedMessage(data)) {
    void markNotificationsRead(LOCAL_READER, [data.historyId]).catch((err: unknown) => {
      console.error("[server-worker] Failed to mark notification read:", err)
    })
    return
  }

  if (starting) return
  starting = true
  void start(data as WorkerConfig)
})
