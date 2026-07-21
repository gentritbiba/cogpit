import { deviceScopedKey } from "@/lib/device"

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

const memoryCache = new Map<string, CacheState>()

function emptyState(): CacheState {
  return { version: 1, entries: {} }
}

function storageKey(): string {
  return deviceScopedKey(STORAGE_KEY)
}

function loadState(): CacheState {
  const key = storageKey()
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

function readEntry(key: string): unknown | undefined {
  const entry = loadState().entries[key]
  if (!entry || Date.now() - entry.savedAt > MAX_AGE_MS) return undefined
  return entry.value
}

function writeEntry(key: string, value: unknown): void {
  const scopedKey = storageKey()
  const current = loadState()
  const entries = {
    ...current.entries,
    [key]: { savedAt: Date.now(), value },
  }

  const ordered = Object.entries(entries).sort(([, a], [, b]) => b.savedAt - a.savedAt)
  const next: CacheState = {
    version: 1,
    entries: Object.fromEntries(ordered.slice(0, MAX_ENTRIES)),
  }
  memoryCache.set(scopedKey, next)

  try {
    localStorage.setItem(scopedKey, JSON.stringify(next))
  } catch {
    // The in-memory cache still makes in-app navigation instant if storage is full.
  }
}

export function readCachedList<T>(key: string): T[] | undefined {
  const value = readEntry(key)
  return Array.isArray(value) ? value as T[] : undefined
}

export function writeCachedList<T>(key: string, value: T[]): void {
  writeEntry(key, value)
}

function sessionPageKey(dirName: string): string {
  return `sessions:${dirName}`
}

export function readCachedSessionPage<T>(dirName: string): CachedSessionPage<T> | undefined {
  const value = readEntry(sessionPageKey(dirName))
  if (!value || typeof value !== "object") return undefined

  const candidate = value as Partial<CachedSessionPage<T>>
  if (!Array.isArray(candidate.sessions) || typeof candidate.total !== "number") return undefined
  return candidate as CachedSessionPage<T>
}

export function writeCachedSessionPage<T>(dirName: string, value: CachedSessionPage<T>): void {
  writeEntry(sessionPageKey(dirName), value)
}

/** Clear the active device's list cache (also useful after logout or in tests). */
export function clearSessionListCache(): void {
  const key = storageKey()
  memoryCache.delete(key)
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore restricted storage environments.
  }
}
