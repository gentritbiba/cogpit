# Electron App Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Electron desktop app support to Cogpit, running alongside the existing web version with zero changes to `src/`.

**Architecture:** Embedded HTTP/WS server inside Electron's main process replicates the Vite plugin API surface. The React frontend loads from the static build and talks to `localhost:<random-port>`. The existing web version (`bun dev`) is completely unaffected.

**Tech Stack:** Electron, electron-vite, electron-builder, Express, node-pty, ws

---

### Task 1: Install Electron dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install electron-vite and electron as dev dependencies**

Run:
```bash
bun add -d electron electron-vite electron-builder @types/express
```

**Step 2: Install express as a production dependency**

Run:
```bash
bun add express
```

**Step 3: Move node-pty and ws from devDependencies to dependencies**

In `package.json`, move `"node-pty": "^1.1.0"` and `"ws": "^8.19.0"` from `devDependencies` to `dependencies`. These are needed at runtime in the Electron main process.

**Step 4: Add electron scripts to package.json**

Add these to the `"scripts"` section of `package.json`:

```json
"electron:dev": "electron-vite dev",
"electron:build": "electron-vite build",
"electron:package": "electron-vite build && electron-builder",
"postinstall": "electron-builder install-app-deps"
```

The `postinstall` script ensures `node-pty` gets rebuilt for Electron's Node version.

**Step 5: Verify web version still works**

Run:
```bash
bun dev
```

Expected: Vite dev server starts normally, no errors. Kill it after confirming.

**Step 6: Commit**

```bash
git add package.json bun.lockb
git commit -m "feat(electron): add electron, electron-vite, express dependencies"
```

---

### Task 2: Create electron-vite config and tsconfig for electron

**Files:**
- Create: `electron.vite.config.ts`
- Create: `tsconfig.electron.json`
- Modify: `tsconfig.json` (add reference)

**Step 1: Create `electron.vite.config.ts`**

```ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath, URL } from "node:url"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      rollupOptions: {
        external: ["node-pty"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
    },
  },
  renderer: {
    root: ".",
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: "index.html",
      },
    },
    plugins: [
      react({
        babel: {
          plugins: [["babel-plugin-react-compiler"]],
        },
      }),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
  },
})
```

**Step 2: Create `tsconfig.electron.json`**

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.electron.tsbuildinfo",
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["electron/**/*.ts"]
}
```

**Step 3: Add reference to `tsconfig.json`**

Add `{ "path": "./tsconfig.electron.json" }` to the `references` array in `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.electron.json" }
  ],
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

**Step 4: Commit**

```bash
git add electron.vite.config.ts tsconfig.electron.json tsconfig.json
git commit -m "feat(electron): add electron-vite config and tsconfig"
```

---

### Task 3: Create the Electron preload script

**Files:**
- Create: `electron/preload.ts`

**Step 1: Create `electron/preload.ts`**

This is a minimal preload. Since we use an embedded HTTP server (not IPC), the preload just needs to exist for security sandboxing:

```ts
// Minimal preload script for Electron security sandbox.
// Since Cogpit uses an embedded HTTP server (not IPC), no APIs are exposed.
// This file is required by electron-vite even if empty.
```

**Step 2: Commit**

```bash
git add electron/preload.ts
git commit -m "feat(electron): add minimal preload script"
```

---

### Task 4: Extract server logic into standalone Express server

This is the biggest task. We extract the route handler logic from `server/api-plugin.ts` (Vite middleware format) into a standalone Express app that can run in Electron's main process.

**Files:**
- Create: `electron/server.ts`
- Read (reference only, do NOT modify): `server/api-plugin.ts`, `server/pty-plugin.ts`, `server/config.ts`

**Step 1: Create `electron/server.ts`**

This file creates a standalone Express + WS server that replicates all API endpoints from `server/api-plugin.ts` and the WebSocket PTY handler from `server/pty-plugin.ts`.

The approach: Import the logic from `server/api-plugin.ts` and `server/pty-plugin.ts` by **extracting their middleware functions into a shared format**. However, since those files are tightly coupled to Vite's middleware API (which is just Connect under the hood, compatible with Express), we can use a simpler approach:

Create `electron/server.ts` that:
1. Creates an Express app
2. Serves static files from the renderer build output (`out/renderer/`)
3. Wraps the existing Vite plugin middleware registration into Express middleware — since Vite's `server.middlewares` is a Connect instance, and Express is Connect-compatible, we can reuse the handler functions directly by copy-adapting them.

**Important:** Rather than importing from `server/api-plugin.ts` directly (which returns a Vite Plugin object), we create a standalone Express server that reimplements the same route handlers. The handlers in `api-plugin.ts` use standard Node.js `(req, res, next)` signatures which are identical to Express middleware.

```ts
import express from "express"
import { createServer } from "node:http"
import { WebSocketServer, WebSocket } from "ws"
import { spawn as ptySpawn, type IPty } from "node-pty"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { readdir, readFile, writeFile, appendFile, stat, lstat, open, mkdir, unlink } from "node:fs/promises"
import { watch } from "node:fs"
import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { createInterface } from "node:readline"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

import { getConfig, loadConfig, saveConfig, validateClaudeDir, getDirs } from "../server/config"

// ── Server factory ──────────────────────────────────────────────────
export async function createAppServer(staticDir: string) {
  const app = express()
  app.use(express.json())

  const httpServer = createServer(app)

  // Load config
  await loadConfig()

  // Mutable directory references
  let dirs = { PROJECTS_DIR: "", TEAMS_DIR: "", TASKS_DIR: "", UNDO_DIR: "" }

  function refreshDirs(): boolean {
    const config = getConfig()
    if (!config) return false
    dirs = getDirs(config.claudeDir)
    return true
  }

  refreshDirs()

  // ── Static files ────────────────────────────────────────────────
  app.use(express.static(staticDir))

  // ── API routes ──────────────────────────────────────────────────
  // NOTE TO IMPLEMENTER:
  // Copy each `server.middlewares.use("/api/...", handler)` from
  // server/api-plugin.ts and convert to `app.get("/api/...", handler)`
  // or `app.post("/api/...", handler)`. The handler signatures are
  // identical — (req, res, next).
  //
  // The full list of endpoints (from api-plugin.ts grep):
  //   GET  /api/config/validate
  //   GET  /api/config
  //   POST /api/config
  //   GET  /api/projects
  //   GET  /api/sessions/:dirName
  //   GET  /api/active-sessions
  //   POST /api/check-ports
  //   GET  /api/background-tasks
  //   POST /api/kill-port
  //   GET  /api/find-session/:id
  //   GET  /api/team-member-session/:teamName/:memberName
  //   POST /api/send-message
  //   POST /api/new-session
  //   POST /api/stop-session
  //   POST /api/kill-all
  //   GET  /api/running-processes
  //   POST /api/kill-process
  //   GET  /api/session-team/:dirName/:fileName
  //   GET  /api/teams
  //   GET  /api/team-detail/:teamName
  //   GET  /api/team-watch/:teamName (SSE)
  //   POST /api/team-message/:teamName
  //   GET  /api/task-output (SSE)
  //   GET  /api/undo-state/:dirName/:fileName
  //   POST /api/undo/apply
  //   POST /api/undo/truncate-jsonl
  //   POST /api/undo/append-jsonl
  //   POST /api/check-files-exist
  //   GET  /api/watch/:dirName/:fileName (SSE)
  //
  // Each handler body is copied verbatim from api-plugin.ts.
  // The only difference: replace `dirs.X` references with the local `dirs` variable.

  // Guard middleware
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/config")) return next()
    if (!getConfig()) {
      res.status(503).json({ error: "Not configured", code: "NOT_CONFIGURED" })
      return
    }
    refreshDirs()
    next()
  })

  // TODO: Copy all route handlers from api-plugin.ts here.
  // This is mechanical — each handler uses (req, res, next) which is Express-compatible.

  // ── SPA fallback ────────────────────────────────────────────────
  app.get("*", (_req, res) => {
    res.sendFile(join(staticDir, "index.html"))
  })

  // ── WebSocket (PTY) ─────────────────────────────────────────────
  // Copy PTY logic from server/pty-plugin.ts
  const sessions = new Map<string, any>()
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url || "/", "http://localhost")
    if (url.pathname !== "/__pty") return

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req)
    })
  })

  // TODO: Copy wss.on("connection", ...) handler and all handle* functions
  // from server/pty-plugin.ts here. They are standalone functions with no
  // Vite dependencies.

  // ── Cleanup on close ────────────────────────────────────────────
  httpServer.on("close", () => {
    for (const session of sessions.values()) {
      if (session.status === "running") {
        session.pty.kill()
      }
    }
    sessions.clear()
  })

  return { app, httpServer }
}
```

**CRITICAL NOTE:** The actual implementation of this file requires copying every route handler from `server/api-plugin.ts` (lines 302-2590+) and every PTY handler from `server/pty-plugin.ts` (lines 59-285). The handlers use standard `(req, res, next)` signatures and work identically in Express. This is mechanical but large (~600 lines of route handlers + ~200 lines of PTY handlers).

**Step 2: Verify the file compiles**

Run:
```bash
bunx tsc --project tsconfig.electron.json --noEmit
```

Expected: No type errors.

**Step 3: Commit**

```bash
git add electron/server.ts
git commit -m "feat(electron): add standalone Express server with all API routes"
```

---

### Task 5: Create the Electron main process entry

**Files:**
- Create: `electron/main.ts`

**Step 1: Create `electron/main.ts`**

```ts
import { app, BrowserWindow, shell } from "electron"
import { join } from "node:path"
import { createAppServer } from "./server"

let mainWindow: BrowserWindow | null = null

async function createWindow(port: number) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Cogpit",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#09090b",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      sandbox: true,
      contextIsolation: true,
    },
  })

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  // In dev, use the Vite dev server URL; in production, use local server
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadURL(`http://localhost:${port}`)
  }

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  // Determine static directory for production builds
  const staticDir = join(__dirname, "../renderer")

  // Start embedded server
  const { httpServer } = await createAppServer(staticDir)

  // Listen on random available port
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve())
  })

  const address = httpServer.address()
  const port = typeof address === "object" && address ? address.port : 0

  if (!port) {
    console.error("Failed to start embedded server")
    app.quit()
    return
  }

  console.log(`Cogpit server listening on http://127.0.0.1:${port}`)

  await createWindow(port)

  // macOS: re-create window when dock icon clicked
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(port)
    }
  })
})

// Quit when all windows are closed (except on macOS)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})
```

**Step 2: Verify it compiles**

Run:
```bash
bunx tsc --project tsconfig.electron.json --noEmit
```

Expected: No type errors.

**Step 3: Commit**

```bash
git add electron/main.ts
git commit -m "feat(electron): add main process entry with BrowserWindow + server"
```

---

### Task 6: Add electron-builder configuration

**Files:**
- Create: `electron-builder.yml`

**Step 1: Create `electron-builder.yml`**

```yaml
appId: com.cogpit.app
productName: Cogpit
copyright: Copyright © 2026 Gentrit Biba

directories:
  output: release
  buildResources: build

files:
  - out/**/*
  - server/config.ts
  - "!node_modules/**/*.{md,map,ts}"

extraMetadata:
  main: out/main/main.js

mac:
  target:
    - target: dmg
      arch:
        - x64
        - arm64
  category: public.app-category.developer-tools
  icon: public/cogpit.svg

linux:
  target:
    - target: AppImage
      arch:
        - x64
    - target: deb
      arch:
        - x64
  category: Development
  icon: public/cogpit.svg

```

**Step 2: Commit**

```bash
git add electron-builder.yml
git commit -m "feat(electron): add electron-builder config for macOS, Linux"
```

---

### Task 7: Add .gitignore entries for Electron output

**Files:**
- Modify: `.gitignore`

**Step 1: Add Electron-specific ignores**

Append these lines to `.gitignore`:

```
# Electron
out/
release/
```

**Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: add electron output dirs to gitignore"
```

---

### Task 8: Smoke test — Electron dev mode launches

**Step 1: Run electron dev**

Run:
```bash
bun run electron:dev
```

Expected: An Electron window opens showing the Cogpit UI. The embedded server starts on a random port (visible in terminal output). The app loads and shows either the setup screen or the dashboard (depending on whether `config.local.json` exists).

**Step 2: Test basic navigation**

- Verify the sidebar loads projects
- Verify clicking a session loads the conversation timeline
- Verify the PTY terminal works (open server panel, spawn a terminal)

**Step 3: Close and verify clean exit**

Close the Electron window. Verify the process exits cleanly (no orphan processes).

---

### Task 9: Test production build and packaging

**Step 1: Build the Electron app**

Run:
```bash
bun run electron:package
```

Expected: Builds complete, output in `release/` directory. On macOS you should see a `.dmg` file.

**Step 2: Open the packaged app**

On macOS:
```bash
open release/*.dmg
```

Drag Cogpit to Applications (or run directly from the mounted DMG). Verify the app launches and works identically to dev mode.

**Step 3: Verify web version is unaffected**

Run:
```bash
bun dev
```

Expected: Normal Vite dev server starts, app works as before. No regressions.
