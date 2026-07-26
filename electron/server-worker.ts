/**
 * Server worker — runs the Express API server in an Electron utilityProcess
 * so that heavy child-process work (claude CLI, PTY sessions, search indexing)
 * never blocks the main process event loop or freezes the UI.
 */
import { createAppServer } from "./server.ts"
import { getConfig } from "../server/config"
import { removePortFile, writePortFile } from "../server/lib/portFile"
import { setDesktopAttention } from "../server/lib/desktopAttention"
import { isDesktopAttentionMessage } from "../shared/notifications"

interface WorkerConfig {
  staticDir: string
  userDataDir: string
  isDev: boolean
}

let starting = false

async function start({ staticDir, userDataDir, isDev }: WorkerConfig): Promise<void> {
  try {
    const { httpServer } = await createAppServer(staticDir, userDataDir)

    const config = getConfig()
    const networkEnabled = config?.networkAccess && config?.networkPassword
    const listenHost = networkEnabled ? "0.0.0.0" : "127.0.0.1"
    const listenPort = (isDev || networkEnabled) ? 19384 : 0

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
    writePortFile(port)
    process.on("exit", removePortFile)

    console.log(`[server-worker] Cogpit server listening on http://${listenHost}:${port}`)
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

  if (starting) return
  starting = true
  void start(data as WorkerConfig)
})
