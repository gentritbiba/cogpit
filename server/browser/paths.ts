import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEFAULT_BROWSER = "default"
export const THROWAWAY_PREFIX = "tmp-"
export const SHARED_RUN_NAME = "shared"

const BROWSER_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/
const COGPIT_SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/

export class BrowserNameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrowserNameError"
  }
}

export function isValidBrowserName(name: string): boolean {
  return BROWSER_NAME.test(name)
}

export function isThrowawayName(name: string): boolean {
  return name.startsWith(THROWAWAY_PREFIX)
}

export function isValidCogpitSessionId(id: string): boolean {
  return COGPIT_SESSION_ID.test(id)
}

export function assertBrowserName(name: string): void {
  if (!isValidBrowserName(name)) {
    throw new BrowserNameError(`Browser name ${JSON.stringify(name)} must match ${BROWSER_NAME.source}`)
  }
}

export function assertNamedBrowser(name: string): void {
  assertBrowserName(name)
  if (isThrowawayName(name)) {
    throw new BrowserNameError(`Browser name ${JSON.stringify(name)} is a throwaway (${THROWAWAY_PREFIX}*), not a named browser`)
  }
}

function assertCogpitSessionId(id: string): void {
  if (!isValidCogpitSessionId(id)) {
    throw new BrowserNameError(`Cogpit session id ${JSON.stringify(id)} must match ${COGPIT_SESSION_ID.source}`)
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

export function sessionRunDir(id: string): string {
  assertCogpitSessionId(id)
  return join(runRoot(), id)
}

export function registryFile(): string {
  return join(browserHome(), "sessions.json")
}

export function pluginDir(): string {
  return join(browserHome(), "plugin")
}
