import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BrowserSessionInfo } from "../../shared/browser/types"
import {
  assertNamedBrowser,
  BrowserNameError,
  browserHome,
  DEFAULT_BROWSER,
  isThrowawayName,
  isValidBrowserName,
  isValidCogpitSessionId,
  profileDir,
  profilesDir,
  registryFile,
} from "./paths"

export const REGISTRY_VERSION = 1

export interface RegistryEntry {
  note?: string
  createdAt: string
  lastUrl?: string
}

export interface BrowserRegistry {
  version: typeof REGISTRY_VERSION
  sessions: Record<string, RegistryEntry>
}

export interface BrowserPatch {
  note?: string | null
  lastUrl?: string
}

export class BrowserExistsError extends Error {
  constructor(name: string) {
    super(`Browser ${JSON.stringify(name)} already exists`)
    this.name = "BrowserExistsError"
  }
}

export class BrowserNotFoundError extends Error {
  constructor(name: string) {
    super(`Browser ${JSON.stringify(name)} does not exist`)
    this.name = "BrowserNotFoundError"
  }
}

const DRIVER_FILE = ".driver"

function isNamedBrowser(name: string): boolean {
  return isValidBrowserName(name) && !isThrowawayName(name)
}

function emptyRegistry(): BrowserRegistry {
  return { version: REGISTRY_VERSION, sessions: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseEntry(value: unknown): RegistryEntry | null {
  if (!isRecord(value) || typeof value.createdAt !== "string") return null
  const entry: RegistryEntry = { createdAt: value.createdAt }
  if (typeof value.note === "string") entry.note = value.note
  if (typeof value.lastUrl === "string") entry.lastUrl = value.lastUrl
  return entry
}

function parseRegistry(raw: string): BrowserRegistry {
  const registry = emptyRegistry()
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || parsed.version !== REGISTRY_VERSION || !isRecord(parsed.sessions)) return registry
  for (const [name, value] of Object.entries(parsed.sessions)) {
    const entry = parseEntry(value)
    if (entry && isNamedBrowser(name)) registry.sessions[name] = entry
  }
  return registry
}

export function readRegistry(): BrowserRegistry {
  try {
    return parseRegistry(readFileSync(registryFile(), "utf8"))
  } catch {
    return emptyRegistry()
  }
}

export function writeRegistry(registry: BrowserRegistry): void {
  mkdirSync(browserHome(), { recursive: true })
  const path = registryFile()
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`)
  renameSync(tmp, path)
}

function entryOf(registry: BrowserRegistry, name: string): RegistryEntry | undefined {
  return Object.hasOwn(registry.sessions, name) ? registry.sessions[name] : undefined
}

function browserExists(registry: BrowserRegistry, name: string): boolean {
  return name === DEFAULT_BROWSER || entryOf(registry, name) !== undefined || existsSync(profileDir(name))
}

function applyPatch(registry: BrowserRegistry, name: string, patch: BrowserPatch): RegistryEntry {
  const entry = entryOf(registry, name) ?? { createdAt: new Date().toISOString() }
  if (patch.note === null) delete entry.note
  else if (patch.note !== undefined) entry.note = patch.note
  if (patch.lastUrl !== undefined) entry.lastUrl = patch.lastUrl
  registry.sessions[name] = entry
  return entry
}

function profileNames(): string[] {
  let entries
  try {
    entries = readdirSync(profilesDir(), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((entry) => entry.isDirectory() && isNamedBrowser(entry.name)).map((entry) => entry.name)
}

function readDriver(name: string): Pick<BrowserSessionInfo, "lastUsedAt" | "driverSessionId"> {
  const path = join(profileDir(name), DRIVER_FILE)
  try {
    const lastUsedAt = statSync(path).mtime.toISOString()
    const content = readFileSync(path, "utf8").trim()
    return { lastUsedAt, driverSessionId: isValidCogpitSessionId(content) ? content : null }
  } catch {
    return { lastUsedAt: null, driverSessionId: null }
  }
}

function describeBrowser(name: string, entry: RegistryEntry | undefined, running: boolean): BrowserSessionInfo {
  return {
    name,
    isDefault: name === DEFAULT_BROWSER,
    running,
    note: entry?.note ?? null,
    createdAt: entry?.createdAt ?? null,
    lastUrl: entry?.lastUrl ?? null,
    ...readDriver(name),
  }
}

function compareSessions(a: BrowserSessionInfo, b: BrowserSessionInfo): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
  if (a.lastUsedAt !== b.lastUsedAt) {
    if (a.lastUsedAt === null) return 1
    if (b.lastUsedAt === null) return -1
    return b.lastUsedAt.localeCompare(a.lastUsedAt)
  }
  return a.name.localeCompare(b.name)
}

export async function listBrowsers(isRunning: (name: string) => Promise<boolean>): Promise<BrowserSessionInfo[]> {
  const registry = readRegistry()
  const names = new Set([DEFAULT_BROWSER, ...profileNames(), ...Object.keys(registry.sessions)])
  const sessions = await Promise.all(
    [...names].map(async (name) => {
      const running = await isRunning(name).catch(() => false)
      return describeBrowser(name, entryOf(registry, name), running)
    }),
  )
  return sessions.sort(compareSessions)
}

export function createBrowser(name: string, note?: string): BrowserSessionInfo {
  assertNamedBrowser(name)
  const registry = readRegistry()
  if (browserExists(registry, name)) throw new BrowserExistsError(name)
  mkdirSync(profileDir(name), { recursive: true })
  const entry = applyPatch(registry, name, { note })
  writeRegistry(registry)
  return describeBrowser(name, entry, false)
}

export function updateBrowser(name: string, patch: BrowserPatch): RegistryEntry {
  assertNamedBrowser(name)
  const registry = readRegistry()
  if (!browserExists(registry, name)) throw new BrowserNotFoundError(name)
  const entry = applyPatch(registry, name, patch)
  writeRegistry(registry)
  return entry
}

export function removeBrowser(name: string): void {
  assertNamedBrowser(name)
  if (name === DEFAULT_BROWSER) {
    throw new BrowserNameError(`The ${DEFAULT_BROWSER} browser cannot be removed`)
  }
  rmSync(profileDir(name), { recursive: true, force: true })
  const registry = readRegistry()
  delete registry.sessions[name]
  writeRegistry(registry)
}

export function touchLastUrl(name: string, url: string): void {
  if (!isNamedBrowser(name)) return
  const registry = readRegistry()
  if (!browserExists(registry, name) || entryOf(registry, name)?.lastUrl === url) return
  applyPatch(registry, name, { lastUrl: url })
  writeRegistry(registry)
}
