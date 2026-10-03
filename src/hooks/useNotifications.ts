import { useCallback, useEffect, useState } from "react"
import { authFetch } from "@/lib/auth"
import { editionUi } from "@/edition/registry"
import type { CogpitNotification } from "../../shared/notifications"

const POLL_INTERVAL_MS = 15_000

export interface UseNotifications {
  notifications: CogpitNotification[]
  unreadCount: number
  refresh: () => Promise<void>
  markRead: (ids: string[]) => Promise<void>
  markAllRead: () => Promise<void>
}

/**
 * Notification inbox for the active device: every notification the server
 * raised (desktop or push), including ones already clicked away.
 */
export function useNotifications(): UseNotifications {
  const [notifications, setNotifications] = useState<CogpitNotification[]>([])

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch("/api/notifications?limit=100")
      if (!res.ok) return
      const data = await res.json() as { notifications?: CogpitNotification[] }
      if (!Array.isArray(data.notifications)) return
      setNotifications(data.notifications)
      editionUi().onInboxRead?.(data.notifications)
    } catch {
      // Transient network failure — the next poll retries.
    }
  }, [])

  // Also read on focus: someone coming back to the app sees what arrived meanwhile.
  useEffect(() => {
    void refresh()
    const onFocus = () => void refresh()
    const timer = window.setInterval(onFocus, POLL_INTERVAL_MS)
    window.addEventListener("focus", onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
    }
  }, [refresh])

  // Marks read optimistically first: the local state is good enough until the
  // next poll even if the request never lands.
  const postRead = useCallback(async (
    body: { ids: string[] } | { all: true },
    matches: (notification: CogpitNotification) => boolean,
  ) => {
    const now = new Date().toISOString()
    setNotifications((current) =>
      current.map((n) => (n.readAt === null && matches(n) ? { ...n, readAt: now } : n)))
    try {
      await authFetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    } catch {
      // Transient network failure — the next poll reconciles.
    }
  }, [])

  const markRead = useCallback(
    async (ids: string[]) => postRead({ ids }, (n) => ids.includes(n.id)),
    [postRead],
  )

  const markAllRead = useCallback(async () => postRead({ all: true }, () => true), [postRead])

  const unreadCount = notifications.filter((n) => n.readAt === null).length

  return { notifications, unreadCount, refresh, markRead, markAllRead }
}
