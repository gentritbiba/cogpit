import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { hostname } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import type { UseFn } from "../helpers"
import { getConfig } from "../config"

export type HubMode = "electron" | "standalone" | "dev"

// ── Module-level identity (computed once per boot) ───────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url))

/** App version, read once at module init. Never throws — "unknown" on failure. */
const VERSION: string = (() => {
  try {
    const pkgPath = join(__dirname, "../../package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown }
    return typeof pkg.version === "string" ? pkg.version : "unknown"
  } catch {
    return "unknown"
  }
})()

/**
 * Random per-boot identifier. The hub uses this to reject a device that is
 * really the hub itself (self-add) — same host reached via a different name.
 */
const INSTANCE_ID: string = randomBytes(8).toString("hex")

/** This instance's per-boot id, consumed by the hub's self-add check. */
export function getInstanceId(): string {
  return INSTANCE_ID
}

/** Human-facing device name: explicit override wins, else the OS hostname. */
function getDeviceName(): string {
  return process.env.COGPIT_DEVICE_NAME || hostname()
}

// ── Route ────────────────────────────────────────────────────────────────

/**
 * Registers the public `/api/hello` handshake endpoint. This is intentionally
 * unauthenticated (listed in PUBLIC_PATHS) and exempt from the NOT_CONFIGURED
 * 503 guard so the hub can identify a device before it holds any credentials.
 * The payload never contains filesystem paths or secrets.
 */
export function registerHelloRoutes(use: UseFn, opts: { mode: HubMode }) {
  use("/api/hello", (req, res, next) => {
    if (req.method !== "GET") return next()

    const config = getConfig()
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({
      app: "cogpit",
      version: VERSION,
      hubApi: 1,
      mode: opts.mode,
      name: getDeviceName(),
      instanceId: INSTANCE_ID,
      networkAccess: config?.networkAccess ?? false,
      configured: config !== null,
    }))
  })
}
