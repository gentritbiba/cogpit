import { app, BrowserWindow, ipcMain } from "electron"
import pkg from "electron-updater"
const { autoUpdater } = pkg
import { join } from "node:path"
import { readFileSync, writeFileSync, existsSync } from "node:fs"

const PREFS_FILE = "update-preferences.json"

interface UpdatePrefs {
  dismissedVersion: string | null
}

function getPrefsPath(): string {
  return join(app.getPath("userData"), PREFS_FILE)
}

function readPrefs(): UpdatePrefs {
  const path = getPrefsPath()
  if (!existsSync(path)) return { dismissedVersion: null }
  try {
    return JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return { dismissedVersion: null }
  }
}

function writePrefs(prefs: UpdatePrefs): void {
  writeFileSync(getPrefsPath(), JSON.stringify(prefs, null, 2))
}

type UpdatePlatform = "appimage" | "mac-notification" | "linux-notification"

function getUpdatePlatform(): UpdatePlatform {
  if (process.platform === "darwin") return "mac-notification"
  if (process.env.APPIMAGE) return "appimage"
  return "linux-notification"
}

async function checkGitHubRelease(): Promise<{ version: string; url: string } | null> {
  try {
    const res = await fetch("https://api.github.com/repos/gentritbiba/cogpit/releases/latest", {
      headers: { "User-Agent": "Cogpit-Updater" },
    })
    if (!res.ok) return null
    const data = await res.json()
    const tag: string = data.tag_name ?? ""
    const version = tag.replace(/^v/, "")
    const url: string = data.html_url ?? ""
    return { version, url }
  } catch {
    return null
  }
}

function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number)
  const l = local.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false
  }
  return false
}

export function initUpdater(mainWindow: BrowserWindow): void {
  const platform = getUpdatePlatform()

  // Listen for dismiss from renderer
  ipcMain.on("dismiss-update", (_event, version: string) => {
    writePrefs({ dismissedVersion: version })
  })

  if (platform === "appimage") {
    // Silent auto-update via electron-updater
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = null

    autoUpdater.on("update-downloaded", (info) => {
      mainWindow.webContents.send("update-downloaded", {
        version: info.version,
      })
    })

    // Check after 5s delay
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {})
    }, 5000)
  } else {
    // macOS or Linux system package: check GitHub API
    setTimeout(async () => {
      const release = await checkGitHubRelease()
      if (!release) return

      const currentVersion = app.getVersion()
      if (!isNewer(release.version, currentVersion)) return

      const prefs = readPrefs()
      if (prefs.dismissedVersion === release.version) return

      mainWindow.webContents.send("update-available", {
        version: release.version,
        url: release.url,
        platform: platform === "mac-notification" ? "mac" : "linux-pkg",
      })
    }, 5000)
  }
}
