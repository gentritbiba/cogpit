import { knownSignIn } from "@/lib/serverSignIn"
import { deviceScopedKey, getActiveIdentity } from "@/lib/device"
import { isRecord } from "../../shared/objects"

interface CacheEntry {
  savedAt: number
  value: unknown
}

interface CacheState {
  version: 1
  entries: Record<string, CacheEntry>
}

export interface CachedSessionPage<T> {
  sessions: T[]
  total: number
}

const STORAGE_KEY = "cogpit:session-list-cache"
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 24

export const sessionListCacheKeys = {
  projects: "projects",
  activeSessions: "active-sessions",
  runningProcesses: "running-processes",
} as const

/** Each list filter keeps its own cached list; the unfiltered list keeps the bare key. */
function filteredCacheKey(base: string, filterKey: string | null): string {
  return filterKey === null ? base : `${base}:${filterKey}`
}

export function activeSessionsCacheKey(filterKey: string | null): string {
  return filteredCacheKey(sessionListCacheKeys.activeSessions, filterKey)
}

const memoryCache = new Map<string, CacheState>()

function emptyState(): CacheState {
  return { version: 1, entries: {} }
}

/**
 * The active device's cache key, or null on a server with account sign-in
 * whose signed-in account is not known yet: until then the key is the one
 * every user of this browser shares, so nothing is read or kept under it.
 */
function storageKey(): string | null {
  if (knownSignIn() === "account" && getActiveIdentity() === null) return null
  return deviceScopedKey(STORAGE_KEY)
}

function loadState(key: string): CacheState {
  const inMemory = memoryCache.get(key)
  if (inMemory) return inMemory

  let state = emptyState()
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CacheState>
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === "object") {
        state = parsed as CacheState
      }
    }
  } catch {
    // A corrupt or unavailable cache must never block loading from the API.
  }

  memoryCache.set(key, state)
  return state
}

function saveState(scopedKey: string, next: CacheState): void {
  memoryCache.set(scopedKey, next)
  try {
    localStorage.setItem(scopedKey, JSON.stringify(next))
  } catch {
    // The in-memory cache still makes in-app navigation instant if storage is full.
  }
}

function readEntry(key: string): unknown | undefined {
  const scopedKey = storageKey()
  const entry = scopedKey === null ? undefined : loadState(scopedKey).entries[key]
  if (!entry || Date.now() - entry.savedAt > MAX_AGE_MS) return undefined
  return entry.value
}

function writeEntry(key: string, value: unknown): void {
  const scopedKey = storageKey()
  if (scopedKey === null) return
  const entries = {
    ...loadState(scopedKey).entries,
    [key]: { savedAt: Date.now(), value },
  }

  const ordered = Object.entries(entries).sort(([, a], [, b]) => b.savedAt - a.savedAt)
  saveState(scopedKey, {
    version: 1,
    entries: Object.fromEntries(ordered.slice(0, MAX_ENTRIES)),
  })
}

function isSessionPage(value: unknown): value is CachedSessionPage<unknown> {
  return isRecord(value) && Array.isArray(value.sessions) && typeof value.total === "number"
}

function withoutSessionRows(rows: readonly unknown[], sessionId: string): unknown[] {
  return rows.filter((row) => !(isRecord(row) && row.sessionId === sessionId))
}

/** A cached list or page without the session's rows; the same value when it had none. */
function withoutSession(value: unknown, sessionId: string): unknown {
  if (Array.isArray(value)) {
    const kept = withoutSessionRows(value, sessionId)
    return kept.length === value.length ? value : kept
  }
  if (!isSessionPage(value)) return value
  const kept = withoutSessionRows(value.sessions, sessionId)
  const dropped = value.sessions.length - kept.length
  return dropped === 0 ? value : { sessions: kept, total: value.total - dropped }
}

export function readCachedList<T>(key: string): T[] | undefined {
  const value = readEntry(key)
  return Array.isArray(value) ? value as T[] : undefined
}

export function writeCachedList<T>(key: string, value: T[]): void {
  writeEntry(key, value)
}

function sessionPageKey(dirName: string, filterKey: string | null): string {
  return filteredCacheKey(`sessions:${dirName}`, filterKey)
}

export function readCachedSessionPage<T>(dirName: string, filterKey: string | null): CachedSessionPage<T> | undefined {
  const value = readEntry(sessionPageKey(dirName, filterKey))
  return isSessionPage(value) ? value as CachedSessionPage<T> : undefined
}

export function writeCachedSessionPage<T>(dirName: string, filterKey: string | null, value: CachedSessionPage<T>): void {
  writeEntry(sessionPageKey(dirName, filterKey), value)
}

/** Drop a session from every list cached for the active device and user: each filter's list and each project's page. */
export function evictSessionFromLists(sessionId: string): void {
  const scopedKey = storageKey()
  if (scopedKey === null) return
  const current = loadState(scopedKey)
  let changed = false
  const entries: Record<string, CacheEntry> = {}
  for (const [key, entry] of Object.entries(current.entries)) {
    const value = withoutSession(entry.value, sessionId)
    changed ||= value !== entry.value
    entries[key] = value === entry.value ? entry : { ...entry, value }
  }
  if (changed) saveState(scopedKey, { version: 1, entries })
}

/** Clear the active device's list cache (also useful after logout or in tests). */
export function clearSessionListCache(): void {
  const key = storageKey()
  if (key === null) return
  memoryCache.delete(key)
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore restricted storage environments.
  }
}
