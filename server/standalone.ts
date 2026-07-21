#!/usr/bin/env bun
/**
 * Standalone server entry point for headless environments.
 * Applies standalone bootstrap policy, then delegates to the shared server
 * composition through a server-owned adapter.
 */
import { join } from "node:path"
import { homedir, hostname, networkInterfaces } from "node:os"
import { mkdirSync, existsSync } from "node:fs"
import { createStandaloneAppServer } from "./standalone-app-server"
import {
  setConfigPath,
  loadConfig,
  getConfig,
  saveConfig,
  applyEnvNetworkOverrides,
} from "./config"
import { validatePasswordStrength } from "./security"
import {
  resolveEnvPassword,
  hasUsableNetworkCredentials,
  shouldFailClosed,
  buildBootBanner,
  resolveDeviceName,
} from "./lib/standalone-bootstrap"

const host = process.env.COGPIT_HOST || "127.0.0.1"
const port = parseInt(process.env.COGPIT_PORT || "19384", 10)
const dataDir = process.env.COGPIT_DATA_DIR || join(homedir(), ".config", "cogpit")

// Resolve static dir: built Vite output
const staticDir = join(import.meta.dirname, "../dist")

// Ensure data directory exists
mkdirSync(dataDir, { recursive: true })

// ── Config bootstrap (before server composition so we can fail closed) ────────
// Server composition re-runs setConfigPath()+loadConfig() with this same path,
// which is harmless; doing it here first lets us synthesize a first-run config
// and enforce the security invariants below before ever binding a socket.
const configPath = join(dataDir, "config.local.json")
setConfigPath(configPath)
const configExisted = existsSync(configPath)
await loadConfig()

// First-run synthesis: a fresh headless box with a real ~/.claude should work
// without any manual setup step. Only when there is no config file at all — a
// persisted config (incl. a Codex-only bootstrap) is left untouched.
if (!configExisted) {
  const claudeDir = join(homedir(), ".claude")
  if (existsSync(join(claudeDir, "projects"))) {
    await saveConfig({ claudeDir })
    console.log(`First run: created ${configPath} for ${claudeDir}`)
  }
}

// ── Env-derived network credentials (in-memory only) ──────────────────────
let envPassword: string | null = null
try {
  envPassword = resolveEnvPassword(process.env)
} catch (err) {
  console.error(
    `Cannot read COGPIT_NETWORK_PASSWORD_FILE: ${(err as Error).message}`,
  )
  process.exit(1)
}

if (envPassword) {
  const strengthError = validatePasswordStrength(envPassword)
  if (strengthError) {
    console.error(`Refusing to start: network password is too weak — ${strengthError}.`)
    process.exit(1)
  }
  applyEnvNetworkOverrides({ password: envPassword })
}

// ── Fail closed: never bind a passwordless server off loopback ─────────────
const hasNetworkCredentials = hasUsableNetworkCredentials(envPassword, getConfig())
if (shouldFailClosed(host, hasNetworkCredentials)) {
  console.error(
    [
      `Refusing to bind ${host}:${port} without a network password.`,
      "",
      `A server reachable off localhost must require authentication. Either:`,
      `  • set COGPIT_NETWORK_PASSWORD (or COGPIT_NETWORK_PASSWORD_FILE) to a`,
      `    strong password before starting, or`,
      `  • configure a network password in ${configPath}`,
      `    (networkAccess: true + networkPassword), or`,
      `  • bind loopback only with COGPIT_HOST=127.0.0.1.`,
    ].join("\n"),
  )
  process.exit(1)
}

const { httpServer, dispose } = await createStandaloneAppServer(staticDir, dataDir)

httpServer.listen(port, host, () => {
  const deviceName = resolveDeviceName(process.env, hostname())
  const banner = buildBootBanner({ deviceName, host, port, interfaces: networkInterfaces() })
  for (const line of banner) console.log(line)
  console.log(`Data directory: ${dataDir}`)
  if (envPassword) {
    console.log("Network access: enabled via environment (password kept in memory only)")
  }
})

// Graceful shutdown
let shuttingDown = false
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\nReceived ${signal}, shutting down...`)
    try {
      await dispose()
      process.exit(0)
    } catch (error) {
      console.error("Failed to shut down cleanly:", error)
      process.exit(1)
    }
  })
}
