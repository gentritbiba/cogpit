import { useEffect, useRef, useState } from "react"
import { Bell, CheckCheck, CircleAlert, MessageSquare } from "lucide-react"
import { useNotifications, type CogpitNotification } from "@/hooks/useNotifications"
import { getActiveDeviceId, LOCAL_DEVICE_ID } from "@/lib/device"
import { revealSessionPath } from "@/lib/revealSession"
import { formatAge } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * Header bell with the notification inbox: every notification the server
 * raised — including ones already clicked or dismissed at the OS level — with
 * click-to-open-session navigation.
 */
export function NotificationsBell() {
  const { notifications, unreadCount, refresh, markRead, markAllRead } = useNotifications()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    void refresh()
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, refresh])

  function openNotification(notification: CogpitNotification): void {
    void markRead([notification.id])
    if (!notification.dirName || !notification.sessionId) return
    const deviceId = getActiveDeviceId()
    const prefix = deviceId === LOCAL_DEVICE_ID ? "" : `/d/${deviceId}`
    revealSessionPath(
      `${prefix}/${encodeURIComponent(notification.dirName)}/${encodeURIComponent(notification.sessionId)}`,
    )
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Notifications — ${unreadCount} unread` : "Notifications"}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "relative flex items-center rounded-md p-1.5 transition-colors",
          open
            ? "bg-elevation-2 text-foreground"
            : "text-muted-foreground hover:text-foreground hover:bg-elevation-2",
        )}
      >
        <Bell className="size-3.5" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-semibold tabular-nums text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-[340px] overflow-hidden rounded-lg border border-border/60 bg-elevation-1 shadow-xl">
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Notifications
            </span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-elevation-2 hover:text-foreground"
              >
                <CheckCheck className="size-3" /> Mark all read
              </button>
            )}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                No notifications yet
              </div>
            ) : (
              notifications.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onOpen={openNotification}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface NotificationRowProps {
  notification: CogpitNotification
  onOpen: (notification: CogpitNotification) => void
}

function NotificationRow({ notification, onOpen }: NotificationRowProps) {
  const unread = notification.readAt === null
  const hasTarget = Boolean(notification.dirName && notification.sessionId)
  const ageSeconds = Math.max(0, (Date.now() - new Date(notification.at).getTime()) / 1000)
  const Icon = notification.kind === "permission" ? CircleAlert : MessageSquare

  return (
    <button
      type="button"
      onClick={() => onOpen(notification)}
      className={cn(
        "flex w-full items-start gap-2.5 border-b border-border/20 px-3 py-2.5 text-left transition-colors last:border-b-0",
        hasTarget ? "hover:bg-elevation-2" : "cursor-default",
        unread ? "bg-blue-500/5" : "opacity-70",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          notification.kind === "permission" ? "text-amber-400" : "text-blue-400",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-xs", unread ? "font-medium text-foreground" : "text-muted-foreground")}>
            {notification.title}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {formatAge(ageSeconds)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {notification.body}
        </span>
      </span>
      {unread && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-blue-400" />}
    </button>
  )
}
