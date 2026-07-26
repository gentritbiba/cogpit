import type { NotificationContent } from "../../shared/notifications"
import { showNotification } from "./desktopNotify"
import { isDesktopAttended } from "./desktopAttention"
import { sendPushNotification } from "./pushNotify"

/**
 * Fan a notification out to every sink.
 *
 * The desktop sink always fires — when the window is focused on that very
 * session the Electron main process drops it, and otherwise it is worth having
 * in Notification Center. Push only fires when the user is *not* at the desktop,
 * so sitting in front of Cogpit never buzzes the phone. A headless server always
 * counts as unattended, which is what makes push the only working channel there.
 *
 * Never throws: notification delivery must not fail the agent turn behind it.
 */
export function deliverNotification(notification: NotificationContent): void {
  try {
    showNotification(notification.title, notification.body, notification.nav)
  } catch (err) {
    console.error("[notify] Desktop notification failed:", err)
  }

  if (isDesktopAttended()) return

  // Deliberately not awaited: the HTTP caller is an agent hook that should not
  // wait on a round trip to a push server.
  void sendPushNotification(notification).catch((err: unknown) => {
    console.error("[notify] Push notification failed:", err)
  })
}
