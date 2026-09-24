import { useState } from "react"
import { Bell, CheckCheck, CircleAlert, MessageSquare, UsersRound, type LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { useNotifications } from "@/hooks/useNotifications"
import { devicePathPrefix } from "@/lib/device"
import { revealSessionPath } from "@/lib/revealSession"
import { formatAge } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { CogpitNotification, NotificationKind } from "../../shared/notifications"

const KIND_ICON: Record<NotificationKind, LucideIcon> = {
  turnComplete: MessageSquare,
  permission: CircleAlert,
  system: MessageSquare,
  access: UsersRound,
}

/**
 * Header bell with the notification inbox: every notification the server
 * raised — including ones already clicked or dismissed at the OS level — with
 * click-to-open-session navigation.
 */
export function NotificationsBell() {
  const { notifications, unreadCount, refresh, markRead, markAllRead } = useNotifications()
  const [open, setOpen] = useState(false)

  function openNotification(notification: CogpitNotification): void {
    void markRead([notification.id])
    if (!notification.dirName || !notification.sessionId) return
    revealSessionPath(
      `${devicePathPrefix()}/${encodeURIComponent(notification.dirName)}/${encodeURIComponent(notification.sessionId)}`,
    )
    setOpen(false)
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) void refresh()
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant={open ? "secondary" : "ghost"}
            size="icon-sm"
            className="relative"
            aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
          />
        }
      >
        <Bell data-icon="inline-start" />
        {unreadCount > 0 && (
          <Badge className="absolute -right-1 -top-1 h-4 min-w-4 px-1 tabular-nums">
            {unreadCount > 99 ? "99+" : unreadCount}
          </Badge>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={6} className="w-80 overflow-hidden p-0">
        <div className="flex h-11 items-center justify-between border-b px-3">
          <span className="text-sm font-medium">Notifications</span>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => void markAllRead()}
            >
              <CheckCheck data-icon="inline-start" />
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {notifications.length === 0 ? (
            <Empty className="min-h-40 p-6">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Bell /></EmptyMedia>
                <EmptyTitle>No notifications</EmptyTitle>
                <EmptyDescription>Session updates will appear here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <DropdownMenuGroup>
              {notifications.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  onOpen={openNotification}
                />
              ))}
            </DropdownMenuGroup>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const Icon = KIND_ICON[notification.kind] ?? MessageSquare

  return (
    <DropdownMenuItem
      onClick={() => onOpen(notification)}
      className={cn(
        "rounded-none border-b px-3 py-2.5 last:border-b-0",
        !hasTarget && "cursor-default",
        unread && "bg-accent/50",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5",
          notification.kind === "permission" ? "text-warning" : "text-info",
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-xs", unread ? "font-medium text-foreground" : "text-muted-foreground")}>
            {notification.title}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatAge(ageSeconds)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {notification.body}
        </span>
      </span>
      {unread && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />}
    </DropdownMenuItem>
  )
}
