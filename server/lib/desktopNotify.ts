import { execFile } from "node:child_process"

export interface NavigationInfo {
  sessionId: string | null
  dirName: string | null
}

export function showNotification(title: string, body: string, nav: NavigationInfo): void {
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
