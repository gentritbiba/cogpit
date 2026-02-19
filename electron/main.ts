import { app, BrowserWindow, session, shell } from "electron"
import { execSync } from "node:child_process"
import { join } from "node:path"
import { createAppServer } from "./server.ts"
import { getConfig } from "../server/config"

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
    },
  })

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  // Always load from the Express server — it serves the built renderer
  // and handles all API routes on the same origin (no proxy needed).
  mainWindow.loadURL(`http://127.0.0.1:${port}`)

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  // Determine static directory for production builds
  const staticDir = join(__dirname, "../renderer")
  const userDataDir = app.getPath("userData")

  // Start embedded server
  const { httpServer } = await createAppServer(staticDir, userDataDir)

  // Bind to 0.0.0.0 when network access is enabled, otherwise localhost only
  const isDev = !!process.env.ELECTRON_RENDERER_URL
  const config = getConfig()
  const networkEnabled = config?.networkAccess && config?.networkPassword

  const listenHost = networkEnabled ? "0.0.0.0" : "127.0.0.1"
  const listenPort = isDev ? 19384 : (networkEnabled ? 19384 : 0)

  await new Promise<void>((resolve) => {
    httpServer.listen(listenPort, listenHost, () => resolve())
  })

  const address = httpServer.address()
  const port = typeof address === "object" && address ? address.port : 0

  if (!port) {
    console.error("Failed to start embedded server")
    app.quit()
    return
  }

  console.log(`Cogpit server listening on http://${listenHost}:${port}`)

  // Grant microphone permission for voice input (Whisper WASM)
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media")
  })

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
