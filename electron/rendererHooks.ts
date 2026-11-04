import type { BrowserWindow } from "electron"

/**
 * Functions the renderer registers on `window` for the main process to call.
 * Each is registered once the part of the app that handles it has mounted, so
 * its presence doubles as the "ready" ack.
 */
export type RendererHook = "__cogpitRevealSession" | "__cogpitOpenKeyboardShortcuts"

/** How long a call keeps retrying to reach a renderer that is still booting. */
const RETRY_ATTEMPTS = 20
const RETRY_DELAY_MS = 250

/**
 * Call a renderer hook, retrying while the renderer is still loading. A
 * fire-and-forget call would land in a renderer that is still booting (cold
 * start, mid-reload) and be silently dropped. False when it never answered.
 */
export async function callRendererHook(win: BrowserWindow, hook: RendererHook, arg?: string): Promise<boolean> {
  const call = `typeof window.${hook} === "function"
    ? (window.${hook}(${arg === undefined ? "" : JSON.stringify(arg)}), true)
    : false`
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (win.isDestroyed()) return false
    try {
      if (await win.webContents.executeJavaScript(call) === true) return true
    } catch {
      // Renderer mid-load; retry below.
    }
    await delay(RETRY_DELAY_MS)
  }
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
