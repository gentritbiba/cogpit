import type { UseFn } from "../helpers"
import { sendJson } from "../helpers"
import { execFile } from "node:child_process"
import { basename, dirname } from "node:path"

let lastNotificationTime = 0
const NOTIFICATION_COOLDOWN_MS = 5000

export function registerNotifyRoutes(use: UseFn): void {
  use("/api/notify", (req, res, next) => {
    if (req.method !== "POST") return next()

    let body = ""
    req.on("data", (chunk: string) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        const data = JSON.parse(body)

        // Throttle: check cooldown before doing any work
        const now = Date.now()
        if (now - lastNotificationTime < NOTIFICATION_COOLDOWN_MS) {
          return sendJson(res, 200, { success: true, throttled: true })
        }
        lastNotificationTime = now

        const cwd: string | null = data.cwd || null
        const transcriptPath: string | null = data.transcript_path || null
        const hookEvent: string | null = data.hook_event_name || data.event || null

        const projectName = cwd ? basename(cwd) : null
        const sessionId: string | null = data.session_id || null
        const dirName = transcriptPath ? basename(dirname(transcriptPath)) : null

        const title = data.title || (projectName ? `Claude Code — ${projectName}` : "Claude Code")
        const message =
          data.body ||
          data.message ||
          (hookEvent === "Stop" ? "Waiting for your input" : "Needs your attention")

        showNotification(title, message, { sessionId, dirName })
        sendJson(res, 200, { success: true })
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" })
      }
    })
  })
}

interface NavigationInfo {
  sessionId: string | null
  dirName: string | null
}

function showNotification(title: string, body: string, nav: NavigationInfo): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Notification, BrowserWindow, app } = require("electron")
    const notification = new Notification({ title, body })

    notification.on("click", () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      win.focus()

      // Navigate to the session in the SPA via popstate
      if (nav.dirName && nav.sessionId) {
        const urlPath = `/${encodeURIComponent(nav.dirName)}/${encodeURIComponent(nav.sessionId)}`
        const safeUrl = JSON.stringify(urlPath)
        win.webContents.executeJavaScript(`
          window.history.pushState({}, '', ${safeUrl});
          window.dispatchEvent(new PopStateEvent('popstate'));
        `)
      }
    })

    notification.show()
    app.dock?.bounce("informational")
  } catch {
    // Fallback to osascript when running outside Electron (e.g. Vite dev server)
    if (process.platform === "darwin") {
      const sanitize = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
      execFile("osascript", ["-e", `display notification "${sanitize(body)}" with title "${sanitize(title)}"`])
    }
  }
}
