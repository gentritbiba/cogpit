import { mkdir, readFile } from "node:fs/promises"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import type { NotificationContent } from "../../shared/notifications"

/**
 * Bounded, persisted log of every notification Cogpit raised — including ones
 * the OS suppressed or the user clicked away — so the UI can show a full
 * notification inbox.
 */

export const NOTIFICATION_HISTORY_FILE = join(homedir(), ".cogpit", "notifications.json")

export type NotificationKind = "turnComplete" | "permission" | "system"

export interface NotificationHistoryEntry {
  id: string
  /** ISO timestamp of when the notification was raised. */
  at: string
  title: string
  body: string
  kind: NotificationKind
  sessionId: string | null
  dirName: string | null
  /** ISO timestamp of when the user clicked/acknowledged it, or null. */
  readAt: string | null
}

const MAX_ENTRIES = 200
const PERSIST_DEBOUNCE_MS = 500

let entries: NotificationHistoryEntry[] | null = null
let loadPromise: Promise<NotificationHistoryEntry[]> | null = null
let persistTimer: NodeJS.Timeout | null = null
let dirty = false
let exitFlushInstalled = false

async function load(): Promise<NotificationHistoryEntry[]> {
  if (entries) return entries
  loadPromise ??= readFile(NOTIFICATION_HISTORY_FILE, "utf-8")
    .then((raw) => {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed.filter(isEntry) as NotificationHistoryEntry[]) : []
    })
    .catch(() => [] as NotificationHistoryEntry[])
    .then((loaded) => {
      entries ??= loaded.slice(0, MAX_ENTRIES)
      return entries
    })
  return loadPromise
}

function isEntry(value: unknown): value is NotificationHistoryEntry {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<NotificationHistoryEntry>
  return typeof candidate.id === "string"
    && typeof candidate.at === "string"
    && typeof candidate.title === "string"
    && typeof candidate.body === "string"
}

function schedulePersist(): void {
  if (!exitFlushInstalled) {
    exitFlushInstalled = true
    // The debounce would otherwise drop a notification raised just before quit.
    process.on("exit", flushSync)
  }
  dirty = true
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    const snapshot = entries
    if (!snapshot) return
    dirty = false
    void mkdir(dirname(NOTIFICATION_HISTORY_FILE), { recursive: true })
      .then(() => writeOwnerOnlyJson(NOTIFICATION_HISTORY_FILE, snapshot))
      .catch((err: unknown) => console.error("[notify] Failed to persist history:", err))
  }, PERSIST_DEBOUNCE_MS)
  persistTimer.unref?.()
}

/** Only synchronous I/O runs inside an exit handler. */
function flushSync(): void {
  if (!dirty || !entries) return
  dirty = false
  try {
    mkdirSync(dirname(NOTIFICATION_HISTORY_FILE), { recursive: true })
    writeFileSync(NOTIFICATION_HISTORY_FILE, JSON.stringify(entries, null, 2), { mode: 0o600 })
  } catch {
    // Quitting anyway; the entry is only as old as one debounce window.
  }
}

/**
 * Record a raised notification. Returns the entry synchronously (its id is
 * needed by the desktop sink before any I/O settles); the append itself happens
 * once the history file has loaded. Shared `loadPromise` ordering keeps
 * concurrent records newest-first.
 */
export function recordNotification(
  content: NotificationContent,
  kind: NotificationKind,
): NotificationHistoryEntry {
  const entry: NotificationHistoryEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    title: content.title,
    body: content.body,
    kind,
    sessionId: content.nav.sessionId,
    dirName: content.nav.dirName,
    readAt: null,
  }
  void load()
    .then((list) => {
      list.unshift(entry)
      if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES
      schedulePersist()
    })
    .catch((err: unknown) => console.error("[notify] Failed to record notification:", err))
  return entry
}

/** Newest-first list of recorded notifications. */
export async function listNotifications(limit = MAX_ENTRIES): Promise<NotificationHistoryEntry[]> {
  const list = await load()
  return list.slice(0, Math.max(0, limit))
}

async function markRead(matches: (entry: NotificationHistoryEntry) => boolean): Promise<void> {
  const list = await load()
  const now = new Date().toISOString()
  let changed = false
  for (const entry of list) {
    if (entry.readAt === null && matches(entry)) {
      entry.readAt = now
      changed = true
    }
  }
  if (changed) schedulePersist()
}

/** Mark the given entries read. Unknown ids are ignored. */
export async function markNotificationsRead(ids: readonly string[]): Promise<void> {
  const wanted = new Set(ids)
  await markRead((entry) => wanted.has(entry.id))
}

/** Mark every entry read. */
export async function markAllNotificationsRead(): Promise<void> {
  await markRead(() => true)
}

/** Reset in-memory state (tests only). */
export function resetNotificationHistoryForTests(seed: NotificationHistoryEntry[] | null = []): void {
  entries = seed
  loadPromise = null
  dirty = false
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
}
