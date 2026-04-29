/**
 * Server worker — runs the Express API server in an Electron utilityProcess
 * so that heavy child-process work (claude CLI, PTY sessions, search indexing)
 * never blocks the main process event loop or freezes the UI.
 */
import { createAppServer } from "./server.ts"
import { getConfig } from "../server/config"

interface WorkerConfig {
  staticDir: string
  userDataDir: string
  isDev: boolean
}

process.parentPort.on("message", async ({ data }: { data: WorkerConfig }) => {
  const { staticDir, userDataDir, isDev } = data

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

    console.log(`[server-worker] Cogpit server listening on http://${listenHost}:${port}`)
    process.parentPort.postMessage({ type: "ready", port })
  } catch (err) {
    console.error("[server-worker] Failed to start server:", err)
    process.parentPort.postMessage({ type: "error", error: String(err) })
  }
})
