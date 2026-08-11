import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"

import { createStandaloneAppServer } from "./standalone-app-server"
import {
  applyEnvNetworkOverrides,
  clearEnvNetworkOverrides,
  getConfig,
  loadConfig,
  saveConfig,
  setConfigPath,
} from "./config"
import { removePortFile, writePortFile } from "./lib/portFile"
import {
  hasUsableNetworkCredentials,
  resolveEnvPassword,
  shouldFailClosed,
} from "./lib/standalone-bootstrap"
import { validatePasswordStrength } from "./security"

export interface StartStandaloneServerOptions {
  staticDir: string
  dataDir?: string
  host?: string
  port?: number
  env?: NodeJS.ProcessEnv
  publishPort?: boolean
}

export interface RunningStandaloneServer {
  host: string
  port: number
  url: string
  dataDir: string
  envPassword: boolean
  dispose: () => Promise<void>
}

function listen(
  server: Awaited<ReturnType<typeof createStandaloneAppServer>>["httpServer"],
  port: number,
  host: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(port, host, () => {
      server.off("error", onError)
      const address = server.address() as AddressInfo | null
      if (!address) {
        reject(new Error("Cogpit started without a listening address."))
        return
      }
      resolve(address.port)
    })
  })
}

/**
 * Start the shared standalone backend against compiled web assets.
 *
 * The regular headless entry point and the install-free npm launcher both use
 * this lifecycle. A port of `0` asks the OS for an available loopback port,
 * which lets `npx cogpit` coexist with an installed Cogpit app.
 */
export async function startStandaloneServer({
  staticDir,
  dataDir = join(homedir(), ".config", "cogpit"),
  host = "127.0.0.1",
  port = 19384,
  env = process.env,
  publishPort = false,
}: StartStandaloneServerOptions): Promise<RunningStandaloneServer> {
  mkdirSync(dataDir, { recursive: true })

  const configPath = join(dataDir, "config.local.json")
  setConfigPath(configPath)
  const configExisted = existsSync(configPath)
  await loadConfig()

  // Prefer a real Claude installation when both providers are available. The
  // config module already synthesizes an in-memory Codex-only configuration.
  if (!configExisted) {
    const claudeDir = join(homedir(), ".claude")
    if (existsSync(join(claudeDir, "projects"))) {
      await saveConfig({ claudeDir })
    }
  }

  let envPassword: string | null
  try {
    envPassword = resolveEnvPassword(env)
  } catch (error) {
    throw new Error(
      `Cannot read COGPIT_NETWORK_PASSWORD_FILE: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  clearEnvNetworkOverrides()
  if (envPassword) {
    const strengthError = validatePasswordStrength(envPassword)
    if (strengthError) {
      throw new Error(`Network password is too weak — ${strengthError}.`)
    }
    applyEnvNetworkOverrides({ password: envPassword })
  }

  if (shouldFailClosed(host, hasUsableNetworkCredentials(envPassword, getConfig()))) {
    throw new Error(
      `Refusing to bind ${host}:${port} without a network password. Bind loopback or configure COGPIT_NETWORK_PASSWORD.`,
    )
  }

  const composition = await createStandaloneAppServer(staticDir, dataDir)
  let boundPort: number
  try {
    boundPort = await listen(composition.httpServer, port, host)
  } catch (error) {
    await composition.dispose()
    throw error
  }

  if (publishPort) writePortFile(boundPort)

  const urlHost = host.includes(":") ? `[${host}]` : host
  let disposed = false
  return {
    host,
    port: boundPort,
    url: `http://${urlHost}:${boundPort}`,
    dataDir,
    envPassword: !!envPassword,
    dispose: async () => {
      if (disposed) return
      disposed = true
      if (publishPort) removePortFile()
      await composition.dispose()
    },
  }
}
