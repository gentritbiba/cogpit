import { execFile } from "node:child_process"
import type { NotificationNav, NotifyMessage } from "../../shared/notifications"

interface ParentMessagePort {
  postMessage(message: unknown): void
}

/**
 * Electron's utilityProcess channel to the main process. Absent in the
 * standalone server and under test.
 */
function parentMessagePort(): ParentMessagePort | null {
  const { parentPort } = process as NodeJS.Process & { parentPort?: ParentMessagePort }
  return parentPort && typeof parentPort.postMessage === "function" ? parentPort : null
}

/**
 * Show a desktop notification.
 *
 * Inside Electron this delegates to the main process, which owns the
 * Notification API — that is what gives the notification the Cogpit icon and a
 * clickable deep link. Only the standalone server falls back to osascript,
 * whose notifications are attributed to Script Editor and cannot be clicked.
 */
export function showNotification(title: string, body: string, nav: NotificationNav): void {
  const port = parentMessagePort()
  if (port) {
    const message: NotifyMessage = { type: "notify", title, body, nav }
    port.postMessage(message)
    return
  }

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
