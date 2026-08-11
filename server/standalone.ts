#!/usr/bin/env bun
/**
 * Standalone server entry point for headless environments.
 * Applies standalone bootstrap policy, then delegates to the shared server
 * composition through a server-owned adapter.
 */
import { join } from "node:path"
import { homedir, hostname, networkInterfaces } from "node:os"
import { removePortFile } from "./lib/portFile"
import {
  buildBootBanner,
  resolveDeviceName,
} from "./lib/standalone-bootstrap"
import { startStandaloneServer } from "./standalone-runtime"

const host = process.env.COGPIT_HOST || "127.0.0.1"
const port = parseInt(process.env.COGPIT_PORT || "19384", 10)
const dataDir = process.env.COGPIT_DATA_DIR || join(homedir(), ".config", "cogpit")

// Resolve static dir: built Vite output
const staticDir = join(import.meta.dirname, "../dist")

let runtime: Awaited<ReturnType<typeof startStandaloneServer>>
try {
  runtime = await startStandaloneServer({
    staticDir,
    dataDir,
    host,
    port,
    publishPort: true,
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const deviceName = resolveDeviceName(process.env, hostname())
const banner = buildBootBanner({
  deviceName,
  host,
  port: runtime.port,
  interfaces: networkInterfaces(),
})
for (const line of banner) console.log(line)
console.log(`Data directory: ${dataDir}`)
if (runtime.envPassword) {
  console.log("Network access: enabled via environment (password kept in memory only)")
}

// Graceful shutdown
let shuttingDown = false
// Windows never delivers SIGTERM to a listener, so the port file would go stale
// on taskkill. SIGBREAK covers Ctrl+Break and "exit" is the last-resort net.
const shutdownSignals = process.platform === "win32"
  ? (["SIGINT", "SIGBREAK"] as const)
  : (["SIGINT", "SIGTERM"] as const)
process.on("exit", () => removePortFile())
for (const signal of shutdownSignals) {
  process.on(signal, async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\nReceived ${signal}, shutting down...`)
    removePortFile()
    try {
      await runtime.dispose()
      process.exit(0)
    } catch (error) {
      console.error("Failed to shut down cleanly:", error)
      process.exit(1)
    }
  })
}
