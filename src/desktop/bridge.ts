/**
 * The renderer's one link to the desktop shell (`desktop/`). Nothing else in
 * the renderer imports Tauri: the rest of the app reads `window.cogpitDesktop`,
 * which stays undefined in a browser.
 */
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import type { DesktopPerformanceSnapshot } from "../../shared/contracts/performance"

/** Elements inside a drag region that keep their own clicks. */
const NO_DRAG = "button, a, input, textarea, select, [role='button']"

export function desktopPlatform(userAgent: string): CogpitDesktop["platform"] {
  if (userAgent.includes("Macintosh")) return "macos"
  if (userAgent.includes("Windows")) return "windows"
  return "linux"
}

export function installDesktopBridge(): void {
  if (!isTauri()) return
  const platform = desktopPlatform(navigator.userAgent)
  window.cogpitDesktop = {
    platform,
    performance: { getSnapshot: () => invoke<DesktopPerformanceSnapshot>("performance_snapshot") },
    updater: {
      getState: () => invoke<DesktopUpdateState>("update_state"),
      onState: (cb) => {
        const listening = listen<DesktopUpdateState>("update-state", (event) => cb(event.payload))
        return () => { void listening.then((stop) => stop()) }
      },
      install: () => invoke<void>("update_install"),
      dismissVersion: (version) => { void invoke("update_dismiss", { version }) },
    },
  }
  document.documentElement.classList.add("desktop", `desktop-${platform}`)
  // Only macOS hides the title bar, under the traffic lights; elsewhere the window keeps its native frame.
  if (platform === "macos") document.addEventListener("mousedown", dragWindow)
}

/**
 * Drag the window from a `.desktop-drag` region or the strip standing in for
 * the title bar, and zoom it on a double click, as a title bar does.
 */
export function dragWindow(event: MouseEvent): void {
  if (event.button !== 0 || !(event.target instanceof Element)) return
  const region = event.target.closest(".desktop-drag, .drag-strip")
  if (!region || event.target.closest(NO_DRAG)) return
  event.preventDefault()
  const window = getCurrentWindow()
  void (event.detail === 2 ? window.toggleMaximize() : window.startDragging())
}
