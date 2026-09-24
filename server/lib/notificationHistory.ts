import { mkdir, readFile } from "node:fs/promises"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { writeOwnerOnlyText } from "../atomicJsonFile"
import { editionModule } from "../edition"
import type { NotificationContent, NotificationKind } from "../../shared/notifications"
import { isRecord } from "../../shared/objects"

/**
 * Bounded, persisted log of every notification Cogpit raised — including ones
 * the OS suppressed or the user clicked away — so the UI can show a full
 * notification inbox. Read state is kept per reader, since a server that signs
 * accounts in has many.
 */

export const NOTIFICATION_HISTORY_FILE = join(homedir(), ".cogpit", "notifications.json")

/** Who reads a notification when the request carries no signed-in user. */
export const LOCAL_READER = "local"

/** A notification as one reader sees it. */
export interface NotificationView {
  id: string
  /** ISO timestamp of when the notification was raised. */
  at: string
  title: string
  body: string
  kind: NotificationKind
  sessionId: string | null
  dirName: string | null
  /** ISO timestamp of when this reader clicked/acknowledged it, or null. */
  readAt: string | null
}

export interface NotificationHistoryEntry extends Omit<NotificationView, "readAt"> {
  /** When each reader acknowledged it, keyed by user id or {@link LOCAL_READER}. */
  readBy: Record<string, string>
  /** Set on a notification meant for this one reader alone: their account id. */
  recipientId?: string
}

/**
 * Notices meant for one reader alone are kept per reader, apart from the
 * host's (whose cap the edition's `notificationRetention` sets), so no one
 * else's activity evicts them and they evict nobody's.
 */
const RECIPIENT_HISTORY = 200

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
      return Array.isArray(parsed) ? parsed.filter(isEntry) : []
    })
    .catch(() => [])
    .then((loaded) => {
      if (entries) return entries
      const current = loaded.map(upgraded)
      if (current.some((entry, index) => entry !== loaded[index])) schedulePersist()
      retain(current)
      entries = current
      return entries
    })
  return loadPromise
}

/** Drop, in place, the entries past the host's cap and past each recipient's, oldest first. */
function retain(list: NotificationHistoryEntry[]): void {
  const hostCap = editionModule().notificationRetention.hostEntries
  const kept = new Map<string | undefined, number>()
  let length = 0
  for (const entry of list) {
    const count = (kept.get(entry.recipientId) ?? 0) + 1
    if (count > (entry.recipientId === undefined ? hostCap : RECIPIENT_HISTORY)) continue
    kept.set(entry.recipientId, count)
    list[length++] = entry
  }
  list.length = length
}

/** What the "access" kind was called before; read as "access" until no history file holds it. */
const LEGACY_ACCESS_KIND = "share"

type StoredEntry = Omit<NotificationHistoryEntry, "kind"> & {
  kind: NotificationKind | typeof LEGACY_ACCESS_KIND
  readAt?: string | null
  /** What `recipientId` was called before; read as `recipientId` until no history file holds it. */
  recipientUserId?: string
}

function isEntry(value: unknown): value is StoredEntry {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<StoredEntry>
  return typeof candidate.id === "string"
    && typeof candidate.at === "string"
    && typeof candidate.title === "string"
    && typeof candidate.body === "string"
}

function hasCurrentKind(entry: StoredEntry): entry is StoredEntry & { kind: NotificationKind } {
  return entry.kind !== LEGACY_ACCESS_KIND
}

/**
 * An entry as this version keeps it, the same object when it already is. A
 * file written before readers were told apart kept one read time, which
 * becomes the local reader's.
 */
function upgraded(entry: StoredEntry): NotificationHistoryEntry {
  if (!hasCurrentKind(entry)) return upgraded({ ...entry, kind: "access" })
  if (entry.recipientUserId !== undefined) {
    const { recipientUserId, ...rest } = entry
    return upgraded({ ...rest, recipientId: recipientUserId })
  }
  if (isRecord(entry.readBy)) return entry
  const { readAt, ...rest } = entry
  return { ...rest, readBy: typeof readAt === "string" ? { [LOCAL_READER]: readAt } : {} }
}

function schedulePersist(): void {
  if (!exitFlushInstalled) {
    exitFlushInstalled = true
    // The write delay would otherwise drop a notification raised just before quit.
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
      .then(() => writeOwnerOnlyText(NOTIFICATION_HISTORY_FILE, JSON.stringify(snapshot)))
      .catch((err: unknown) => console.error("[notify] Failed to persist history:", err))
  }, editionModule().notificationRetention.persistDelayMs)
  persistTimer.unref?.()
}

/** Only synchronous I/O runs inside an exit handler. */
function flushSync(): void {
  if (!dirty || !entries) return
  dirty = false
  try {
    mkdirSync(dirname(NOTIFICATION_HISTORY_FILE), { recursive: true })
    writeFileSync(NOTIFICATION_HISTORY_FILE, JSON.stringify(entries), { mode: 0o600 })
  } catch {
    // Quitting anyway; what is lost is at most one write delay's changes.
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
  recipientId?: string,
): NotificationHistoryEntry {
  const entry: NotificationHistoryEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    title: content.title,
    body: content.body,
    kind,
    sessionId: content.nav.sessionId,
    dirName: content.nav.dirName,
    readBy: {},
    ...(recipientId === undefined ? {} : { recipientId }),
  }
  void load()
    .then((list) => {
      list.unshift(entry)
      retain(list)
      schedulePersist()
    })
    .catch((err: unknown) => console.error("[notify] Failed to record notification:", err))
  return entry
}

/** Every recorded notification, newest first. */
export async function listNotifications(): Promise<NotificationHistoryEntry[]> {
  return (await load()).slice()
}

export function notificationView(entry: NotificationHistoryEntry, reader: string): NotificationView {
  const { readBy, recipientId: _recipient, ...view } = entry
  return { ...view, readAt: Object.hasOwn(readBy, reader) ? readBy[reader] : null }
}

/** Mark the given entries read for one reader. Unknown ids are ignored. */
export async function markNotificationsRead(reader: string, ids: readonly string[]): Promise<void> {
  const wanted = new Set(ids)
  const now = new Date().toISOString()
  let changed = false
  for (const entry of await load()) {
    if (wanted.has(entry.id) && !Object.hasOwn(entry.readBy, reader)) {
      entry.readBy[reader] = now
      changed = true
    }
  }
  if (changed) schedulePersist()
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
