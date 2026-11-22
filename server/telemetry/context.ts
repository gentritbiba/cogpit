import { arch, platform, release } from "node:os"
import packageJson from "../../package.json"
import { sanitizeProperties, type TelemetryProperties } from "./events"

/** How this copy of Cogpit runs: the desktop app, or a server opened in a browser. */
export type TelemetryShell = "desktop" | "standalone"
/** Where this copy came from. */
export type TelemetryDistribution = "desktop" | "npm" | "source"

const FALSE = new Set(["0", "false", "off", "no"])
const TRUE = new Set(["1", "true", "on", "yes"])

function flag(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (FALSE.has(normalized)) return false
  if (TRUE.has(normalized)) return true
  return undefined
}

/**
 * Whether this server sends usage data. It does unless `COGPIT_TELEMETRY=0` or
 * `DO_NOT_TRACK=1` says otherwise. A development build, a test run or CI would
 * each count as an install of its own, so they stay off unless
 * `COGPIT_TELEMETRY=1` asks for it.
 */
export function telemetryEnabled(env: NodeJS.ProcessEnv, development: boolean): boolean {
  const setting = flag(env.COGPIT_TELEMETRY)
  if (setting === false || flag(env.DO_NOT_TRACK) === true) return false
  if (setting === true) return true
  return !development && !env.VITEST && env.NODE_ENV !== "test" && flag(env.CI) !== true
}

function osName(): string {
  switch (platform()) {
    case "darwin": return "macos"
    case "win32": return "windows"
    default: return platform()
  }
}

/** The kernel or OS release, to its first two parts. */
function osVersion(): string {
  return release().split(/[.-]/).slice(0, 2).join(".")
}

export interface ContextInput {
  shell: TelemetryShell
  distribution: TelemetryDistribution
  edition: string
  env: NodeJS.ProcessEnv
}

/**
 * What every event carries: the build, the system, and the language and
 * timezone settings. Never the host name, the user name or any path.
 */
export function commonProperties({ shell, distribution, edition, env }: ContextInput): TelemetryProperties {
  const intl = Intl.DateTimeFormat().resolvedOptions()
  return sanitizeProperties({
    appVersion: packageJson.version,
    edition,
    shell,
    distribution,
    os: osName(),
    osVersion: osVersion(),
    arch: arch(),
    wsl: Boolean(env.WSL_DISTRO_NAME),
    locale: intl.locale,
    timezone: intl.timeZone,
  })
}
