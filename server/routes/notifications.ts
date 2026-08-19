import { readJsonBody, sendJson, type UseFn } from "../http"
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
} from "../lib/notificationHistory"

/**
 * Notification inbox API.
 *
 *   GET  /api/notifications            → { notifications: NotificationHistoryEntry[] }
 *   POST /api/notifications/read       → { ids: string[] } | { all: true }
 *
 * Notifications themselves are raised by the session activity monitor
 * (server/lib/sessionActivityMonitor.ts) — there is no ingest endpoint.
 */
export function registerNotificationRoutes(use: UseFn): void {
  use("/api/notifications", async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost")

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10)
      const notifications = await listNotifications(Number.isFinite(limit) ? limit : 100)
      return sendJson(res, 200, { notifications })
    }

    if (req.method === "POST" && url.pathname === "/read") {
      let body: { ids?: unknown; all?: unknown }
      try {
        body = await readJsonBody(req)
      } catch {
        return sendJson(res, 400, { error: "Invalid JSON body" })
      }
      if (body.all === true) {
        await markAllNotificationsRead()
        return sendJson(res, 200, { success: true })
      }
      if (Array.isArray(body.ids) && body.ids.every((id) => typeof id === "string")) {
        await markNotificationsRead(body.ids as string[])
        return sendJson(res, 200, { success: true })
      }
      return sendJson(res, 400, { error: "Expected { ids: string[] } or { all: true }" })
    }

    next()
  })
}
