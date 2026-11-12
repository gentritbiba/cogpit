import { app, BrowserWindow, ipcMain, net } from "electron"
import pkg from "electron-updater"
const { autoUpdater } = pkg
import { join } from "node:path"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { DEFAULT_FEED_URL, fetchFeed, isNewer, pickMacArchive } from "./updateFeed.ts"
import { replaceableAppPath, stageMacUpdate, swapAfterExit, type StagedMacUpdate } from "./macBundleUpdate.ts"

export type UpdateState =
  | { status: "idle" }
  | { status: "available"; version: string; url: string; via: "download" | "package-manager" }
  | { status: "ready"; version: string; asksForPassword: boolean }
  | { status: "failed"; version: string; message: string; url: string }

/**
 * - mac: Cogpit's own bundle swap (see macBundleUpdate.ts)
 * - nsis, appimage, pacman: electron-updater; pacman installs through `pkexec pacman -U`
 * - notify: a Linux install Cogpit cannot replace, so it only points at the release
 */
type Installer = "mac" | "nsis" | "appimage" | "pacman" | "notify"

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const RELEASES_URL = "https://github.com/gentritbiba/cogpit/releases"
const PREFS_FILE = "update-preferences.json"

let state: UpdateState = { status: "idle" }

function setState(next: UpdateState): void {
  state = next
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("update:state", state)
}

function prefsPath(): string {
  return join(app.getPath("userData"), PREFS_FILE)
}

function dismissedVersion(): string | null {
  if (!existsSync(prefsPath())) return null
  try {
    return JSON.parse(readFileSync(prefsPath(), "utf-8")).dismissedVersion ?? null
  } catch {
    return null
  }
}

function installerFor(): Installer {
  if (process.platform === "darwin") return "mac"
  if (process.platform === "win32") return "nsis"
  if (process.env.APPIMAGE) return "appimage"
  // electron-builder writes this file into fpm packages (pacman, deb, rpm).
  const packageType = join(process.resourcesPath, "package-type")
  if (existsSync(packageType) && readFileSync(packageType, "utf8").trim() === "pacman") return "pacman"
  return "notify"
}

function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`
}

function announce(version: string, via: "download" | "package-manager"): void {
  if (dismissedVersion() === version) return
  setState({ status: "available", version, url: releaseUrl(version), via })
}

function startElectronUpdater(installer: "nsis" | "appimage" | "pacman", feedUrl: string | undefined): () => Promise<unknown> {
  autoUpdater.logger = null
  autoUpdater.autoDownload = true
  // pacman asks for a password, which must not appear unprompted while quitting.
  autoUpdater.autoInstallOnAppQuit = installer !== "pacman"
  if (feedUrl) autoUpdater.setFeedURL({ provider: "generic", url: feedUrl })
  autoUpdater.on("update-downloaded", (info) => {
    setState({ status: "ready", version: info.version, asksForPassword: installer === "pacman" })
  })
  // Linux installers run synchronously inside quitAndInstall and report failure through this event.
  let installing = false
  autoUpdater.on("error", (error) => {
    if (installing && state.status === "ready") setState({ status: "failed", version: state.version, message: error.message, url: releaseUrl(state.version) })
  })
  ipcMain.handle("update:install", () => {
    if (state.status !== "ready") return
    installing = true
    try {
      autoUpdater.quitAndInstall(true, true)
    } finally {
      installing = false
    }
  })
  return () => autoUpdater.checkForUpdates()
}

function startMacUpdater(feedUrl: string): () => Promise<unknown> {
  const appPath = replaceableAppPath(process.execPath, process.resourcesPath)
  let staged: StagedMacUpdate | null = null
  let relaunch = false

  app.on("will-quit", () => {
    if (!staged) return
    swapAfterExit(staged, relaunch)
    staged = null
  })
  ipcMain.handle("update:install", () => {
    if (!staged) return
    relaunch = true
    app.quit()
  })

  return async () => {
    const feed = await fetchFeed(net.fetch, feedUrl, "latest-mac.yml")
    if (!isNewer(feed.version, app.getVersion()) || staged?.version === feed.version) return
    const archive = pickMacArchive(feed, process.arch)
    if (!appPath || !archive) return announce(feed.version, "download")
    // Staging replaces whatever an earlier check staged.
    staged = null
    try {
      staged = await stageMacUpdate(net.fetch, appPath, feed.version, new URL(archive.url, feedUrl).href, archive)
    } catch (error) {
      announce(feed.version, "download")
      throw error
    }
    setState({ status: "ready", version: feed.version, asksForPassword: false })
  }
}

function startNotifier(feedUrl: string): () => Promise<unknown> {
  return async () => {
    const feed = await fetchFeed(net.fetch, feedUrl, "latest-linux.yml")
    if (isNewer(feed.version, app.getVersion())) announce(feed.version, "package-manager")
  }
}

export function initUpdater(): void {
  ipcMain.handle("update:get-state", () => state)
  ipcMain.on("update:dismiss", (_event, version: string) => {
    writeFileSync(prefsPath(), JSON.stringify({ dismissedVersion: version }, null, 2))
  })
  if (!app.isPackaged) return

  // Points every installer at a generic feed instead of the GitHub release, e.g. a mirror or a local QA server.
  const feedOverride = process.env.COGPIT_UPDATE_FEED_URL
  const feedUrl = feedOverride ?? DEFAULT_FEED_URL
  const installer = installerFor()
  const check = installer === "mac" ? startMacUpdater(feedUrl)
    : installer === "notify" ? startNotifier(feedUrl)
    : startElectronUpdater(installer, feedOverride)

  let checking = false
  const run = async () => {
    if (checking) return
    checking = true
    try {
      await check()
    } catch (error) {
      // Usually offline or a release without manifests; the next interval retries.
      console.warn("[updater] Update check failed:", error)
    } finally {
      checking = false
    }
  }
  setTimeout(run, 5000)
  const interval = setInterval(run, CHECK_INTERVAL_MS)
  app.on("before-quit", () => clearInterval(interval))
}
