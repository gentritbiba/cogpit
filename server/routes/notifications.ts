import type { IncomingMessage } from "node:http"
import type { SessionAccessLevel } from "../../shared/contracts/sessionAccess"
import type { NotificationKind } from "../../shared/notifications"
import { getRequestPrincipal, itemVisibilityFor, takeInOrder } from "../edition"
import { readJsonBody, sendJson, type UseFn } from "../http"
import {
  listNotifications,
  LOCAL_READER,
  markNotificationsRead,
  notificationView,
  type NotificationHistoryEntry,
} from "../lib/notificationHistory"

/**
 * Notification inbox API.
 *
 *   GET  /api/notifications            → { notifications: NotificationView[] }
 *   POST /api/notifications/read       → { ids: string[] } | { all: true }
 *
 * Notifications themselves are raised by the session activity monitor
 * (server/lib/sessionActivityMonitor.ts) — there is no ingest endpoint. Each
 * caller sees and marks read only the notifications they may see, and read
 * state is their own.
 */

const DEFAULT_LIMIT = 100
/** The newest notifications a caller may see make up their inbox; the log holds more for other readers. */
const INBOX_SIZE = 200

function readerFor(req: IncomingMessage): string {
  return getRequestPrincipal(req)?.userId ?? LOCAL_READER
}

/** Notices that ask for the reader's input go only to those who can give it by sending a message. */
const NEEDED_TO_SEE: Record<NotificationKind, SessionAccessLevel> = {
  turnComplete: "interact",
  permission: "interact",
  system: "view",
  access: "view",
}

/**
 * Whether the caller may see a notification: one meant for a single user
 * reaches only that user; one about a session, whoever holds the level its
 * kind needs there; one about the host itself, whoever may act host-wide.
 */
function notificationVisibility(req: IncomingMessage): (entry: NotificationHistoryEntry) => Promise<boolean> {
  const userId = getRequestPrincipal(req)?.userId
  const visible = itemVisibilityFor(req)
  return async (entry) => {
    if (entry.recipientId !== undefined) {
      if (entry.recipientId !== userId) return false
      if (entry.sessionId === null) return true
    }
    return visible(entry.sessionId, NEEDED_TO_SEE[entry.kind])
  }
}

export function registerNotificationRoutes(use: UseFn): void {
  use("/api/notifications", async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost")

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10)
      const limit = Math.min(INBOX_SIZE, Math.max(0, Number.isFinite(requested) ? requested : DEFAULT_LIMIT))
      const reader = readerFor(req)
      const notifications = (await takeInOrder(await listNotifications(), notificationVisibility(req), limit))
        .map((entry) => notificationView(entry, reader))
      return sendJson(res, 200, { notifications })
    }

    if (req.method === "POST" && url.pathname === "/read") {
      let body: { ids?: unknown; all?: unknown }
      try {
        body = await readJsonBody(req)
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON body" })
      }
      const { ids, all } = body
      const named = Array.isArray(ids) && ids.every((id) => typeof id === "string") ? new Set<string>(ids) : null
      if (all !== true && !named) {
        return sendJson(res, 400, { error: "Expected { ids: string[] } or { all: true }" })
      }
      const entries = await listNotifications()
      const shows = notificationVisibility(req)
      const marked = all === true
        ? await takeInOrder(entries, shows, INBOX_SIZE)
        : await takeInOrder(entries.filter((entry) => named?.has(entry.id)), shows, Infinity)
      await markNotificationsRead(readerFor(req), marked.map((entry) => entry.id))
      return sendJson(res, 200, { success: true })
    }

    next()
  })
}
