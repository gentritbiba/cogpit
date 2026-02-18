import { app, BrowserWindow, shell } from "electron"
import { join } from "node:path"
import { createAppServer } from "./server.ts"

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

  // Random port — renderer loads directly from this server
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
