import { execFile } from "node:child_process"
import { sessionPath, type NotificationNav } from "../../shared/notifications"
import { postToDesktopShell } from "./desktopShell"

/**
 * Show a desktop notification.
 *
 * Inside the desktop app this hands it to the shell, which owns the native
 * notification API: that is what gives the notification the Cogpit icon and a
 * clickable deep link. Only the standalone server falls back to osascript,
 * whose notifications are attributed to Script Editor and cannot be clicked.
 */
export function showNotification(
  title: string,
  body: string,
  nav: NotificationNav,
  historyId?: string,
): void {
  if (postToDesktopShell({ type: "notify", title, body, nav, historyId, path: sessionPath(nav) })) return

  if (process.platform === "darwin") {
    execFile(
      "osascript",
      ["-e", `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}"`],
      // This is the standalone server's only desktop channel, so a silent
      // failure here would leave no trace at all.
      (err) => { if (err) console.error("[notify] osascript failed:", err.message) },
    )
  }
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}
