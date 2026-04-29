import { app, BrowserWindow, Menu, session, shell, systemPreferences, utilityProcess } from "electron"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { initUpdater } from "./updater.ts"

// GUI apps don't inherit the user's shell PATH.
// Spawn their shell to get the real PATH so `claude` CLI is found.
try {
  const userShell = process.env.SHELL || "/bin/zsh"
  const realPath = execSync(`${userShell} -ilc 'echo -n "$PATH"'`, { encoding: "utf-8" })
  if (realPath) process.env.PATH = realPath
} catch {
  // Fall back to system PATH
}

let mainWindow: BrowserWindow | null = null
let serverProcess: Electron.UtilityProcess | null = null

async function createWindow(port: number) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Cogpit",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    backgroundColor: "#09090b",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  // Intercept in-page link clicks that would navigate away from the app
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const appOrigin = `http://127.0.0.1:${port}`
    if (!url.startsWith(appOrigin)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  // Always load from the Express server — it serves the built renderer
  // and handles all API routes on the same origin (no proxy needed).
  mainWindow.loadURL(`http://127.0.0.1:${port}`)

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

/**
 * Fork the API server into a utilityProcess so that heavy work
 * (child processes, PTY I/O, SQLite queries) never blocks the
 * main process event loop or freezes the renderer.
 */
function startServerWorker(staticDir: string, userDataDir: string, isDev: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const workerPath = join(__dirname, "server-worker.js")
    serverProcess = utilityProcess.fork(workerPath)

    const timeout = setTimeout(() => {
      reject(new Error("Server worker timed out after 15s"))
    }, 15_000)

    serverProcess.on("message", (msg: { type: string; port?: number; error?: string }) => {
      if (msg.type === "ready" && msg.port) {
        clearTimeout(timeout)
        resolve(msg.port)
      } else if (msg.type === "error") {
        clearTimeout(timeout)
        reject(new Error(msg.error || "Server worker failed"))
      }
    })

    serverProcess.on("exit", (code) => {
      clearTimeout(timeout)
      if (code !== 0 && code !== null) {
        console.error(`[main] Server worker exited with code ${code}`)
      }
      serverProcess = null
    })

    // Send configuration to the worker
    serverProcess.postMessage({ staticDir, userDataDir, isDev })
  })
}

app.whenReady().then(async () => {
  // Determine static directory for production builds
  const staticDir = join(__dirname, "../renderer")
  const userDataDir = app.getPath("userData")
  const isDev = !!process.env.ELECTRON_RENDERER_URL

  // Start server in a separate utility process
  let port: number
  try {
    port = await startServerWorker(staticDir, userDataDir, isDev)
  } catch (err) {
    console.error("Failed to start server worker:", err)
    app.quit()
    return
  }

  console.log(`Cogpit server ready on port ${port} (utility process)`)

  // Grant microphone permission for voice input (Whisper WASM)
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media")
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  // macOS: request system-level microphone access BEFORE loading the window
  // so the OS permission dialog appears proactively. Without this, getUserMedia
  // fails with NotAllowedError because macOS blocks unregistered apps.
  if (process.platform === "darwin") {
    await systemPreferences.askForMediaAccess("microphone").catch(() => {})
  }

  // Custom menu: removes macOS "Show Tab Bar" (Ctrl+Cmd+T) which
  // conflicts with the open-terminal shortcut in the renderer.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
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
        { role: "zoom" },
        { role: "close" },
      ],
    },
  ]))

  await createWindow(port)

  // Initialize auto-updater / update notifications
  if (mainWindow) {
    initUpdater(mainWindow)
  }

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

// Clean up the server worker when the app quits
app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill()
    serverProcess = null
  }
})
