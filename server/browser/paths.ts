import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  BROWSER_NAME_RE,
  DEFAULT_BROWSER,
  isThrowawayName,
  isValidBrowserName,
  THROWAWAY_PREFIX,
} from "../../shared/browser/names"

export { BROWSER_NAME_RE, DEFAULT_BROWSER, isThrowawayName, isValidBrowserName, THROWAWAY_PREFIX }

export const SHARED_RUN_NAME = "shared"

/**
 * What Cogpit passes for `COGPIT_SESSION_ID` when the process it is spawning
 * serves every session rather than one — a shared app-server, a headless CLI.
 * Deliberately not a valid id: the shim then files throwaways under
 * `run/shared` and stamps an empty `.driver`, so no browser is attributed to a
 * session that does not own it.
 */
export const NO_COGPIT_SESSION = ""

/** Also rendered into the shim, which reads `COGPIT_SESSION_ID` before using it. */
export const COGPIT_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export class BrowserNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrowserNameError"
  }
}

export function isValidCogpitSessionId(id: string): boolean {
  return COGPIT_SESSION_ID_RE.test(id)
}

export function assertBrowserName(name: string): void {
  if (!isValidBrowserName(name)) {
    throw new BrowserNameError(`Browser name ${JSON.stringify(name)} must match ${BROWSER_NAME_RE.source}`)
  }
}

export function assertNamedBrowser(name: string): void {
  assertBrowserName(name)
  if (isThrowawayName(name)) {
    throw new BrowserNameError(`Browser name ${JSON.stringify(name)} is a throwaway (${THROWAWAY_PREFIX}*), not a named browser`)
  }
}

export function browserHome(): string {
  return process.env.COGPIT_BROWSER_HOME || join(homedir(), ".cogpit", "browser")
}

export function binDir(): string {
  return join(dirname(browserHome()), "bin")
}

export function shimPath(): string {
  return join(binDir(), "agent-browser")
}

export function profilesDir(): string {
  return join(browserHome(), "profiles")
}

export function profileDir(name: string): string {
  assertNamedBrowser(name)
  return join(profilesDir(), name)
}

export function runRoot(): string {
  return join(browserHome(), "run")
}

export function sharedRunDir(): string {
  return join(runRoot(), SHARED_RUN_NAME)
}

export function registryFile(): string {
  return join(browserHome(), "sessions.json")
}

export function pluginDir(): string {
  return join(browserHome(), "plugin")
}

/** Names the one Cogpit allowed to reap this tree; see `acquireSweepOwnership`. */
export function sweepOwnerFile(): string {
  return join(browserHome(), "sweeper.owner")
}
