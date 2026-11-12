/**
 * Server entry for the desktop app. The shell (`desktop/`) runs this as a
 * sidecar process and talks to it over stdin/stdout (`shared/desktopProtocol.ts`).
 *
 *   desktop.js --static-dir <renderer build> --data-dir <user data> [--core-bin <cogpit-core>]
 *
 * A built app passes the core binary it ships; without one the server finds
 * the checkout's own build (`server/core/binary.ts`).
 *
 * `COGPIT_RENDERER_DEV_URL` (set by `bun run desktop:dev`) serves the renderer
 * from Vite instead of the build.
 */
import { parseArgs } from "node:util"
import type { AddressInfo } from "node:net"
import { CLICKUP_CONFIG_FILE } from "./lib/clickupConfig"
import { createServerComposition } from "./app-server"
import { getConfig } from "./config"
import { detachFromParentCogpit } from "./lib/parentCogpit"
import { removePortFile, setServerPort, writePortFile } from "./lib/portFile"
import { setDesktopAttention } from "./lib/desktopAttention"
import { connectDesktopShell, postToDesktopShell } from "./lib/desktopShell"
import { startSessionActivityMonitor } from "./lib/sessionActivityMonitor"
import { startDelegatedRequestWatcher } from "./sessionHosts/delegatedRequests"
import { startSlack } from "./slack"
import { flushSessionCatalog, startSessionCatalogAfterFirstResponse } from "./sessionCatalog"
import { LOCAL_READER, markNotificationsRead } from "./lib/notificationHistory"
import { computeDesktopAttention } from "../shared/notifications"

// stdout is the protocol channel, so every log line goes to stderr.
console.log = console.error
console.info = console.error
console.debug = console.error

const { values: args } = parseArgs({
  options: {
    "static-dir": { type: "string" },
    "data-dir": { type: "string" },
    "core-bin": { type: "string" },
  },
})

let exiting = false
function shutdown(): void {
  if (exiting) return
  exiting = true
  // Keep what the session catalog learned; removePortFile runs on exit.
  void flushSessionCatalog().finally(() => process.exit(0))
}

connectDesktopShell(process.stdin, process.stdout, {
  onMessage(message) {
    if (message.type === "desktop-presence") {
      setDesktopAttention(computeDesktopAttention(message))
      return
    }
    void markNotificationsRead(LOCAL_READER, [message.historyId]).catch((err: unknown) => {
      console.error("[desktop] Failed to mark notification read:", err)
    })
  },
  onShutdown: shutdown,
})
process.once("SIGTERM", shutdown)

async function start(staticDir: string, dataDir: string): Promise<number> {
  detachFromParentCogpit()
  const { httpServer } = await createServerComposition(staticDir, dataDir, {
    mode: "desktop",
    legacyClickUpPath: CLICKUP_CONFIG_FILE,
    viteDevUrl: process.env.COGPIT_RENDERER_DEV_URL,
    coreBin: args["core-bin"],
  })

  // Network access pins the well-known port so other devices can find this one.
  const config = getConfig()
  const networkEnabled = !!(config?.networkAccess && config.networkPassword)
  const host = networkEnabled ? "0.0.0.0" : "127.0.0.1"

  startSessionCatalogAfterFirstResponse(httpServer)
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once("error", reject)
    httpServer.listen(networkEnabled ? 19384 : 0, host, () => {
      httpServer.off("error", reject)
      resolve((httpServer.address() as AddressInfo).port)
    })
  })

  // Published so agent hooks can find us on an ephemeral port. Removed on exit
  // so a hook can never POST session text to whatever process inherits the
  // port after Cogpit quits.
  setServerPort(port)
  writePortFile(port)
  process.on("exit", removePortFile)

  console.log(`[desktop] Cogpit server listening on http://${host}:${port}`)
  startSessionActivityMonitor()
  startDelegatedRequestWatcher()
  startSlack()
  return port
}

/** Exit once the error line has reached the shell; a pipe write may still be queued. */
function fail(error: string): void {
  postToDesktopShell({ type: "error", error })
  process.stdout.write("", () => process.exit(1))
}

const staticDir = args["static-dir"]
const dataDir = args["data-dir"]
if (!staticDir || !dataDir) {
  fail("The desktop server needs --static-dir and --data-dir.")
} else {
  try {
    postToDesktopShell({ type: "ready", port: await start(staticDir, dataDir) })
  } catch (err) {
    console.error("[desktop] Failed to start the server:", err)
    fail(err instanceof Error ? err.message : String(err))
  }
}
