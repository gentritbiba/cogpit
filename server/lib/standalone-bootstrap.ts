import { readFileSync } from "node:fs"
import type { NetworkInterfaceInfo } from "node:os"

/**
 * Pure, side-effect-light helpers for the headless standalone bootstrap.
 * Kept separate from server/standalone.ts so the security-critical decisions
 * (which credential wins, when to fail closed, what to advertise) are unit
 * testable without spawning a real server or reading process.exit.
 */

// ── Env-derived network password ─────────────────────────────────────────

/**
 * Resolve the headless network password from the environment.
 *
 * COGPIT_NETWORK_PASSWORD_FILE wins over COGPIT_NETWORK_PASSWORD (plays nicely
 * with systemd LoadCredential / Docker/K8s secret files). The file's single
 * trailing newline is trimmed. Returns null when neither is set (or empty).
 *
 * Throws if the referenced file cannot be read — a misconfigured credential
 * path must be loud, never silently passwordless.
 */
export function resolveEnvPassword(
  env: NodeJS.ProcessEnv = process.env,
  readFileFn: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): string | null {
  const file = env.COGPIT_NETWORK_PASSWORD_FILE
  if (file && file.length > 0) {
    const trimmed = readFileFn(file).replace(/\r?\n$/, "")
    return trimmed.length > 0 ? trimmed : null
  }
  const inline = env.COGPIT_NETWORK_PASSWORD
  return inline && inline.length > 0 ? inline : null
}

// ── Bind-host safety ─────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "::ffff:127.0.0.1",
])

/** True when binding this host only exposes the loopback interface. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase())
}

/**
 * A passwordless server must never bind a non-loopback interface. Returns true
 * when the requested host is reachable off-box but no network password exists.
 */
export function shouldFailClosed(host: string, hasNetworkPassword: boolean): boolean {
  return !isLoopbackHost(host) && !hasNetworkPassword
}

// ── Boot banner ──────────────────────────────────────────────────────────

type InterfaceMap = Record<string, NetworkInterfaceInfo[] | undefined>

/** First non-internal IPv4 address across all interfaces, or null. */
export function firstNonInternalIPv4(interfaces: InterfaceMap): string | null {
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address
    }
  }
  return null
}

export interface BannerInfo {
  deviceName: string
  host: string
  port: number
  interfaces: InterfaceMap
}

/**
 * Resolve the address a remote hub should target. For a wildcard bind
 * (0.0.0.0 / ::) advertise the machine's LAN IPv4; otherwise the bind host.
 */
export function resolveAdvertisedHost(host: string, interfaces: InterfaceMap): string | null {
  if (host === "0.0.0.0" || host === "::") {
    return firstNonInternalIPv4(interfaces)
  }
  return host
}

/** Build the human-facing boot banner lines (no I/O — caller prints them). */
export function buildBootBanner(info: BannerInfo): string[] {
  const advertised = resolveAdvertisedHost(info.host, info.interfaces)
  const target = advertised ? `${advertised}:${info.port}` : `<this-machine-ip>:${info.port}`
  const lines = [
    `Cogpit device "${info.deviceName}" is listening.`,
    `  Local:   http://127.0.0.1:${info.port}`,
  ]
  if (advertised && !isLoopbackHost(advertised)) {
    lines.push(`  Network: http://${advertised}:${info.port}`)
  } else if (info.host === "0.0.0.0" || info.host === "::") {
    lines.push(`  Network: (no non-internal IPv4 detected — check your interfaces)`)
  }
  lines.push(`  Add this device in Cogpit: Devices → Add device → ${target}`)
  return lines
}

/** Device name advertised to the hub (COGPIT_DEVICE_NAME overrides hostname). */
export function resolveDeviceName(env: NodeJS.ProcessEnv, hostname: string): string {
  const name = env.COGPIT_DEVICE_NAME
  return name && name.trim().length > 0 ? name.trim() : hostname
}
