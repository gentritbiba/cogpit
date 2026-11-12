import { app, BrowserWindow, dialog, ipcMain, Menu, shell, utilityProcess } from "electron"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { initUpdater } from "./updater.ts"
import { appMenuTemplate } from "./appMenu.ts"
import { loadingPageUrl } from "./loadingPage.ts"
import { installNavigationPolicy } from "./navigationPolicy.ts"
import {
  ATTENTION_WINDOW_EVENTS,
  handleWorkerNotification,
  startAttentionReporting,
} from "./notifications.ts"
import { callRendererHook } from "./rendererHooks.ts"
import { startupFailureMessage, waitForServerReady } from "./serverStartup.ts"
import { loginShellPath } from "./shellPath.ts"
import { openStartupLog, type StartupLog } from "./startupLog.ts"
import { packagedCoreBinary } from "./packagedCore.ts"

// Windows routes toasts through this ID; it must match the electron-builder
// appId or notifications are silently dropped.
if (process.platform === "win32") app.setAppUserModelId("com.cogpit.app")

/** The production renderer build, served by the local server. */
const STATIC_DIR = join(__dirname, "../renderer")

let mainWindow: BrowserWindow | null = null
let serverProcess: Electron.UtilityProcess | null = null
/** Known once the server is listening; until then windows show the loading page. */
let appOrigin: string | null = null
let quitting = false
/** Aborted on quit so a slow login shell is not left running. */
const shellPathProbe = new AbortController()
/** Set once the worker exists; re-reports desktop presence to it. */
let reportAttention: (() => void) | null = null

function processName(metric: Electron.ProcessMetric): string {
  if (metric.pid === serverProcess?.pid) return "Server"
  if (metric.type === "Browser") return "App"
  if (metric.type === "Tab") return "Renderer"
  if (metric.type === "GPU") return "GPU"
  if (metric.type === "Utility") return metric.serviceName || "Utility"
  return metric.type
}

ipcMain.handle("performance:get-snapshot", () => ({
  capturedAt: Date.now(),
  processes: app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    name: processName(metric),
    type: metric.type,
    cpuPercent: metric.cpu.percentCPUUsage,
    memoryMb: metric.memory.workingSetSize / 1024,
    ...(typeof metric.cpu.idleWakeupsPerSecond === "number"
      ? { idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond }
      : {}),
  })),
}))

/**
 * macOS insets its traffic lights into the hidden title bar; Windows has no
 * equivalent, so the native Window Controls Overlay has to draw the
 * minimize/maximize/close buttons or the window cannot be closed.
 */
function titleBarOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#09090b", symbolColor: "#a1a1aa", height: 32 },
    }
  }
  return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 14 } }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Cogpit",
    ...titleBarOptions(),
    backgroundColor: "#09090b",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      // Session I/O lives in the utility process, so hidden windows can safely
      // throttle renderer timers and animation frames to save power.
      backgroundThrottling: true,
    },
  })
  mainWindow = win

  for (const event of ATTENTION_WINDOW_EVENTS) {
    // Electron declares one overload per event name, so a union needs narrowing.
    win.on(event as "focus", () => reportAttention?.())
  }

  win.on("closed", () => {
    mainWindow = null
    reportAttention?.()
  })

  if (appOrigin) openApp(win, appOrigin)
  else win.loadURL(loadingPageUrl(readAppMark())).catch(() => {})

  // The worker may already be reporting presence; re-report now that there is a window.
  reportAttention?.()
  return win
}

/** Always load from the local server: it serves the built renderer and every API route on one origin. */
function openApp(win: BrowserWindow, origin: string): void {
  installNavigationPolicy(win.webContents, origin, (url) => shell.openExternal(url))
  win.loadURL(origin)
}

function readAppMark(): string | null {
  try {
    return readFileSync(join(STATIC_DIR, "cogpit.svg"), "utf8")
  } catch {
    return null
  }
}

function openKeyboardShortcuts(): void {
  const win = mainWindow ?? createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  void callRendererHook(win, "__cogpitOpenKeyboardShortcuts").then((handled) => {
    if (!handled) console.error("[main] Keyboard shortcuts could not reach the renderer")
  })
}

/**
 * Fork the API server into a utilityProcess so that heavy work
 * (child processes, PTY I/O, SQLite queries) never blocks the
 * main process event loop or freezes the renderer.
 */
function startServerWorker(userDataDir: string, isDev: boolean, log: StartupLog): Promise<number> {
  const worker = utilityProcess.fork(join(__dirname, "server-worker.js"), [], { stdio: "pipe" })
  serverProcess = worker

  // Piped rather than inherited so startup output also reaches the log a
  // failed launch points at.
  worker.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk)
    log.write(chunk)
  })
  worker.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk)
    log.write(chunk)
  })

  // The worker cannot construct Notifications itself; it asks us to. Clicks
  // are reported back so notification history reflects them.
  worker.on("message", (msg: unknown) =>
    handleWorkerNotification(msg, mainWindow, (reply) => serverProcess?.postMessage(reply)))

  // ...and it cannot see window focus, so we tell it when to use the phone.
  reportAttention = startAttentionReporting(
    () => mainWindow,
    (message) => serverProcess?.postMessage(message),
  )

  worker.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[main] Server worker exited with code ${code}`)
    }
    if (serverProcess === worker) serverProcess = null
  })

  const ready = waitForServerReady(worker)
  // An unpackaged run (electron:dev, electron:preview) uses the checkout's own core build.
  const coreBin = app.isPackaged ? packagedCoreBinary(process.resourcesPath) : undefined
  worker.postMessage({ staticDir: STATIC_DIR, userDataDir, isDev, coreBin })
  return ready
}

function failStartup(err: unknown, logPath: string | null): void {
  console.error("[main] Cogpit could not start:", err)
  // Quitting mid-start kills the worker, which is not a failure to report.
  if (!quitting) dialog.showErrorBox("Cogpit could not start", startupFailureMessage(err, logPath))
  app.quit()
}

async function startApp(): Promise<void> {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, {
    openExternal: (url) => void shell.openExternal(url),
    openKeyboardShortcuts,
  })))

  // Show the window straight away; the server can take seconds to start.
  createWindow()
  // macOS: re-create window when dock icon clicked
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // GUI apps don't inherit the user's shell PATH, and the server worker needs
  // it to find the agent CLIs.
  const shellPath = await loginShellPath(process.env.SHELL || "/bin/zsh", { signal: shellPathProbe.signal })
  if (shellPath) process.env.PATH = shellPath
  if (quitting) return

  const startupLog = openStartupLog(() => app.getPath("logs"))
  let port: number
  try {
    port = await startServerWorker(app.getPath("userData"), !!process.env.ELECTRON_RENDERER_URL, startupLog)
  } catch (err) {
    failStartup(err, startupLog.path)
    return
  } finally {
    startupLog.close()
  }

  console.log(`Cogpit server ready on port ${port} (utility process)`)
  appOrigin = `http://127.0.0.1:${port}`
  initUpdater()
  if (mainWindow) openApp(mainWindow, appOrigin)
}

// Anything else that throws during startup would otherwise leave the app
// running with no server and nothing on screen to say so.
app.whenReady().then(startApp).catch((err: unknown) => failStartup(err, null))

// Quit when all windows are closed (except on macOS)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

// Clean up the server worker when the app quits
app.on("before-quit", () => {
  quitting = true
  shellPathProbe.abort()
  if (!serverProcess) return
  const pid = serverProcess.pid
  // Windows has no process groups, so killing the worker alone orphans every
  // claude/codex/git/PTY process it spawned.
  if (process.platform === "win32" && pid) {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      serverProcess.kill()
    }
  } else {
    serverProcess.kill()
  }
  serverProcess = null
})
