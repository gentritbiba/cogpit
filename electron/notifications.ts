import { app, BrowserWindow, Notification, powerMonitor } from "electron"
import {
  computeDesktopAttention,
  isNotifyMessage,
  isViewingSession,
  sessionPath,
  type DesktopAttentionMessage,
  type NotifyMessage,
} from "../shared/notifications"

/** Idle time changes without emitting events, so it has to be sampled. */
const IDLE_POLL_MS = 30_000

/**
 * Tell the server whether the user is at the desktop, so it can route to the
 * phone when they are not.
 *
 * Reported on lock/suspend events and re-sampled on a slow timer, because
 * "walked away" produces no event at all — it is simply the absence of input.
 */
export function startAttentionReporting(
  getWindow: () => BrowserWindow | null,
  post: (message: DesktopAttentionMessage) => void,
): () => void {
  let locked = false
  let lastPosted: boolean | null = null

  function report(): void {
    const win = getWindow()
    const attended = computeDesktopAttention({
      hasWindow: !!win && !win.isDestroyed(),
      locked,
      idleSeconds: powerMonitor.getSystemIdleTime(),
    })
    // The poll would otherwise repost the same value every 30s.
    if (attended === lastPosted) return
    lastPosted = attended
    post({ type: "desktop-attention", attended })
  }

  function setLocked(value: boolean): void {
    locked = value
    report()
  }

  powerMonitor.on("lock-screen", () => setLocked(true))
  powerMonitor.on("unlock-screen", () => setLocked(false))
  powerMonitor.on("suspend", () => setLocked(true))
  powerMonitor.on("resume", () => setLocked(false))

  setInterval(report, IDLE_POLL_MS).unref()
  report()

  return report
}

/**
 * Window events after which presence may have changed. Attached by the caller,
 * which owns the window lifecycle.
 */
export const ATTENTION_WINDOW_EVENTS = [
  "focus",
  "blur",
  "show",
  "hide",
  "minimize",
  "restore",
] as const

/**
 * Present a notification requested by the server utilityProcess.
 *
 * Suppressed only when the window is focused *and* already showing that
 * session — a backgrounded, minimized, or differently-scrolled window is worth
 * interrupting for.
 */
export function handleWorkerNotification(message: unknown, win: BrowserWindow | null): void {
  if (!isNotifyMessage(message)) return

  // Runs at the top of a main-process event handler, where a throw would be an
  // uncaught exception that takes the app down.
  try {
    if (!Notification.isSupported()) return

    const live = win && !win.isDestroyed() ? win : null
    if (live && isWindowActive(live) && isViewingSession(live.webContents.getURL(), message.nav)) return

    const notification = new Notification({ title: message.title, body: message.body })
    notification.on("click", () => revealSession(message, live))
    notification.show()
    app.dock?.bounce("informational")
  } catch (err) {
    console.error("[main] Failed to present notification:", err)
  }
}

function isWindowActive(win: BrowserWindow): boolean {
  return win.isFocused() && win.isVisible() && !win.isMinimized()
}

/** Bring Cogpit forward and route the SPA to the session that notified. */
function revealSession(message: NotifyMessage, target: BrowserWindow | null): void {
  const win = target && !target.isDestroyed() ? target : BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return

  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  app.focus({ steal: true })

  const path = sessionPath(message.nav)
  if (!path) return

  void win.webContents.executeJavaScript(`
    window.history.pushState({}, '', ${JSON.stringify(path)});
    window.dispatchEvent(new PopStateEvent('popstate'));
  `)
}
