import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Well-known location for the port the local server bound to.
 *
 * Agent hooks need this because the packaged app binds an ephemeral port unless
 * network access pins it to 19384 — a hard-coded port in a hook would silently
 * stop delivering notifications.
 */
export const PORT_FILE = join(homedir(), ".cogpit", "port")

let boundPort: number | null = null

/** The port this process serves on, which agents it starts receive as `COGPIT_PORT`. */
export function setServerPort(port: number): void {
  boundPort = port
}

export function serverPort(): number | null {
  return boundPort
}

export function resetServerPortForTest(): void {
  boundPort = null
}

export function writePortFile(port: number): void {
  try {
    mkdirSync(dirname(PORT_FILE), { recursive: true })
    writeFileSync(PORT_FILE, `${port}\n`, { mode: 0o600 })
  } catch (err) {
    console.error("[portFile] Failed to publish server port:", err)
  }
}

export function removePortFile(): void {
  try {
    rmSync(PORT_FILE, { force: true })
  } catch (err) {
    console.error("[portFile] Failed to remove port file:", err)
  }
}
