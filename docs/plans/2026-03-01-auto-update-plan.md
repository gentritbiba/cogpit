# Auto-Update Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic updates for Linux AppImage users and update-available notifications for macOS/Linux system-package users.

**Architecture:** Linux AppImage uses `electron-updater` for silent background auto-update. macOS and Linux system-package installs check the GitHub Releases API on startup, and display an in-app banner with "Download" / "Don't show again". Dismissed versions are persisted in Electron userData as a JSON file.

**Tech Stack:** electron-updater, Electron IPC (contextBridge/ipcRenderer/ipcMain), GitHub Releases API, React

---

### Task 1: Install electron-updater

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run: `bun add electron-updater`

**Step 2: Verify it installed**

Run: `grep electron-updater package.json`
Expected: `"electron-updater": "^X.Y.Z"` in dependencies

**Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add electron-updater dependency"
```

---

### Task 2: Add publish config to electron-builder

**Files:**
- Modify: `electron-builder.yml`

**Step 1: Add publish provider and zip target**

Add `publish` block at the top level, and add `zip` to mac targets (needed for future code-signed auto-updates):

```yaml
appId: com.cogpit.app
productName: Cogpit
copyright: "Copyright © 2026 Gentrit Biba"

publish:
  provider: github
  owner: gentritbiba
  repo: cogpit

directories:
  output: release
  buildResources: build

asar: true
compression: maximum

files:
  - out/**/*
  - "!out/**/*.map"
  - "!node_modules/**/*.{md,map,ts,d.ts}"
  - "!node_modules/**/{CHANGELOG,README,LICENSE,LICENCE,readme,changelog}*"
  - "!node_modules/**/{test,tests,__tests__,spec,specs,example,examples,docs}/**"

extraMetadata:
  main: out/main/main.js

mac:
  target:
    - target: dmg
      arch:
        - x64
        - arm64
    - target: zip
      arch:
        - x64
        - arm64
  category: public.app-category.developer-tools
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist

linux:
  target:
    - target: AppImage
      arch:
        - x64
    - target: pacman
      arch:
        - x64
  category: Development

pacman:
  depends:
    - c-ares
    - gcc-libs
    - glibc
    - gtk3
    - libcups
    - libdrm
    - libnotify
    - libxcrypt-compat
    - libxss
    - mesa
    - nss
    - alsa-lib
```

**Step 2: Commit**

```bash
git add electron-builder.yml
git commit -m "chore: add publish config and zip target to electron-builder"
```

---

### Task 3: Create the updater module

**Files:**
- Create: `electron/updater.ts`

**Step 1: Write the updater module**

This module handles three cases:
1. **AppImage** — uses `electron-updater` for silent auto-update
2. **macOS** — checks GitHub API, sends IPC to renderer
3. **Linux system pkg** — checks GitHub API, sends IPC to renderer

```typescript
import { app, BrowserWindow, ipcMain } from "electron"
import { autoUpdater } from "electron-updater"
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

function isAppImage(): boolean {
  return !!process.env.APPIMAGE
}

type UpdatePlatform = "appimage" | "mac-notification" | "linux-notification"

function getUpdatePlatform(): UpdatePlatform {
  if (process.platform === "darwin") return "mac-notification"
  if (isAppImage()) return "appimage"
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
```

**Step 2: Commit**

```bash
git add electron/updater.ts
git commit -m "feat: add updater module with auto-update and notification support"
```

---

### Task 4: Add IPC bridge in preload

**Files:**
- Modify: `electron/preload.ts`

**Step 1: Add contextBridge and ipcRenderer**

Replace the entire file contents:

```typescript
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("electronUpdater", {
  onUpdateAvailable: (cb: (info: { version: string; url: string; platform: string }) => void) => {
    ipcRenderer.on("update-available", (_event, info) => cb(info))
  },
  onUpdateDownloaded: (cb: (info: { version: string }) => void) => {
    ipcRenderer.on("update-downloaded", (_event, info) => cb(info))
  },
  dismissVersion: (version: string) => {
    ipcRenderer.send("dismiss-update", version)
  },
})
```

**Step 2: Commit**

```bash
git add electron/preload.ts
git commit -m "feat: add IPC bridge for update notifications in preload"
```

---

### Task 5: Initialize updater in main process

**Files:**
- Modify: `electron/main.ts`

**Step 1: Import initUpdater**

Add this import at the top of `electron/main.ts`, after the existing imports:

```typescript
import { initUpdater } from "./updater.ts"
```

**Step 2: Call initUpdater after window creation**

In the `app.whenReady()` callback, after `await createWindow(port)` (line 133), add:

```typescript
  // Initialize auto-updater / update notifications
  if (mainWindow) {
    initUpdater(mainWindow)
  }
```

**Step 3: Commit**

```bash
git add electron/main.ts
git commit -m "feat: initialize updater on app startup"
```

---

### Task 6: Add TypeScript declarations for the IPC bridge

**Files:**
- Create: `src/types/electron-updater.d.ts`

**Step 1: Write the type declaration**

```typescript
interface ElectronUpdaterAPI {
  onUpdateAvailable: (cb: (info: { version: string; url: string; platform: string }) => void) => void
  onUpdateDownloaded: (cb: (info: { version: string }) => void) => void
  dismissVersion: (version: string) => void
}

interface Window {
  electronUpdater?: ElectronUpdaterAPI
}
```

**Step 2: Commit**

```bash
git add src/types/electron-updater.d.ts
git commit -m "feat: add TypeScript declarations for electronUpdater IPC bridge"
```

---

### Task 7: Create the UpdateBanner component

**Files:**
- Create: `src/components/UpdateBanner.tsx`

**Step 1: Write the component**

```tsx
import { useState, useEffect } from "react"
import { X, Download, ArrowUpCircle } from "lucide-react"

interface UpdateInfo {
  version: string
  url: string
  platform: string // "mac" | "linux-pkg"
}

interface DownloadedInfo {
  version: string
}

export function UpdateBanner() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [downloadedInfo, setDownloadedInfo] = useState<DownloadedInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const api = window.electronUpdater
    if (!api) return

    api.onUpdateAvailable((info) => {
      setUpdateInfo(info)
    })

    api.onUpdateDownloaded((info) => {
      setDownloadedInfo(info)
    })
  }, [])

  // AppImage: update downloaded, show restart prompt
  if (downloadedInfo && !dismissed) {
    return (
      <div className="flex items-center gap-3 bg-emerald-500/10 border-b border-emerald-500/20 px-4 py-2 text-sm">
        <ArrowUpCircle className="size-4 text-emerald-400 shrink-0" />
        <span className="text-emerald-300">
          Cogpit v{downloadedInfo.version} is ready — restart to apply
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setDismissed(true)}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Dismiss"
        >
          <X className="size-4" />
        </button>
      </div>
    )
  }

  // macOS / Linux system pkg: update available notification
  if (updateInfo && !dismissed) {
    return (
      <div className="flex items-center gap-3 bg-blue-500/10 border-b border-blue-500/20 px-4 py-2 text-sm">
        <ArrowUpCircle className="size-4 text-blue-400 shrink-0" />
        <span className="text-blue-300">
          Cogpit v{updateInfo.version} is available
        </span>
        <div className="flex-1" />
        {updateInfo.platform === "mac" ? (
          <a
            href={updateInfo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-md bg-blue-500/20 px-2.5 py-1 text-xs font-medium text-blue-300 hover:bg-blue-500/30 transition-colors"
          >
            <Download className="size-3" />
            Download
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">
            Update via your package manager
          </span>
        )}
        <button
          onClick={() => {
            setDismissed(true)
            window.electronUpdater?.dismissVersion(updateInfo.version)
          }}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
        >
          Don't show again
        </button>
      </div>
    )
  }

  return null
}
```

**Step 2: Commit**

```bash
git add src/components/UpdateBanner.tsx
git commit -m "feat: add UpdateBanner component for update notifications"
```

---

### Task 8: Render UpdateBanner in App.tsx

**Files:**
- Modify: `src/App.tsx`

**Step 1: Import UpdateBanner**

Add import at the top of `src/App.tsx` alongside the other component imports (around line 26):

```typescript
import { UpdateBanner } from "@/components/UpdateBanner"
```

**Step 2: Add to desktop layout**

In the desktop layout return (around line 747), add `<UpdateBanner />` right after the opening `<div>` and before `<DesktopHeader>`:

Find this block (around line 747):
```tsx
    <div className={`${themeCtx.themeClasses} flex h-dvh flex-col bg-elevation-0 text-foreground`}>
      <DesktopHeader
```

Change to:
```tsx
    <div className={`${themeCtx.themeClasses} flex h-dvh flex-col bg-elevation-0 text-foreground`}>
      <UpdateBanner />
      <DesktopHeader
```

**Step 3: Add to mobile layout**

In the mobile layout return (around line 593), same pattern:

Find:
```tsx
      <div className={`${themeCtx.themeClasses} flex h-dvh flex-col bg-elevation-0 text-foreground`}>
        <main className="flex flex-1 min-h-0 overflow-hidden">
```

Change to:
```tsx
      <div className={`${themeCtx.themeClasses} flex h-dvh flex-col bg-elevation-0 text-foreground`}>
        <UpdateBanner />
        <main className="flex flex-1 min-h-0 overflow-hidden">
```

**Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: render UpdateBanner in desktop and mobile layouts"
```

---

### Task 9: Update release workflow

**Files:**
- Modify: `.github/workflows/release.yml`

**Step 1: Switch AppImage build to --publish always**

In the matrix, change the AppImage `cmd` to use `--publish always` so electron-builder uploads the AppImage and generates `latest-linux.yml`:

Find:
```yaml
          - os: ubuntu-latest
            name: Linux (AppImage)
            cmd: bun run electron:package -- --linux AppImage --x64 --publish never
            pattern: "release/*.AppImage"
```

Change to:
```yaml
          - os: ubuntu-latest
            name: Linux (AppImage)
            cmd: bun run electron:package -- --linux AppImage --x64 --publish always
            pattern: "release/*.AppImage"
```

Also add the `GH_TOKEN` env var to the build step. Find the build step:

```yaml
      - name: Build and package (${{ matrix.name }})
        run: ${{ matrix.cmd }}
        env:
          CSC_IDENTITY_AUTO_DISCOVERY: false
```

Change to:
```yaml
      - name: Build and package (${{ matrix.name }})
        run: ${{ matrix.cmd }}
        env:
          CSC_IDENTITY_AUTO_DISCOVERY: false
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: enable --publish always for AppImage auto-update metadata"
```

---

### Task 10: Add electron-updater to rollup externals

**Files:**
- Modify: `electron.vite.config.ts`

**Step 1: Add electron-updater to external list**

The `externalizeDepsPlugin()` should handle this automatically, but `node-pty` is explicitly externalized. Verify electron-updater is not bundled by checking the main build config. The `externalizeDepsPlugin()` in electron-vite already externalizes all `node_modules` for the main process, so `electron-updater` will be externalized automatically. No changes needed to `electron.vite.config.ts`.

However, we need to make sure `electron-updater` is NOT in `devDependencies` — it must be in `dependencies` since it needs to be available at runtime in the packaged app. The `bun add electron-updater` in Task 1 already handles this (adds to `dependencies` by default).

**No code change needed. Skip this task.**

---

### Task 11: Run tests and verify build

**Step 1: Run existing tests**

Run: `bun run test`
Expected: All existing tests pass (the new code has no test files yet — it's Electron-only code that can't run in vitest's happy-dom environment)

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No type errors

**Step 3: Verify electron build compiles**

Run: `bun run electron:build`
Expected: Builds without errors into `out/` directory

**Step 4: Commit any fixes if needed**
