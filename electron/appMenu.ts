import type { MenuItemConstructorOptions } from "electron"
import { DOCUMENTATION_URL, REPORT_ISSUE_URL } from "../shared/helpLinks"

export interface AppMenuActions {
  openExternal(url: string): void
  openKeyboardShortcuts(): void
}

/**
 * The application menu. Custom rather than Electron's default so macOS loses
 * "Show Tab Bar" (Ctrl+Cmd+T), which collides with the open-terminal shortcut.
 */
export function appMenuTemplate(platform: NodeJS.Platform, actions: AppMenuActions): MenuItemConstructorOptions[] {
  const isWindows = platform === "win32"
  return [
    isWindows
      ? { label: "File", submenu: [{ role: "quit", label: "Exit" }] }
      : { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(isWindows ? [] : [{ role: "zoom" as const }]),
        { role: "close" },
      ],
    },
    {
      role: "help",
      submenu: [
        { label: "Documentation", click: () => actions.openExternal(DOCUMENTATION_URL) },
        { label: "Keyboard Shortcuts", click: () => actions.openKeyboardShortcuts() },
        { type: "separator" },
        { label: "Report an Issue", click: () => actions.openExternal(REPORT_ISSUE_URL) },
      ],
    },
  ]
}
