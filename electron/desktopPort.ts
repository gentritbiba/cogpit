import { readFileSync, writeFileSync } from "node:fs"
import type { Server } from "node:http"
import { join } from "node:path"

/**
 * The window's origin includes the server port, and the renderer's
 * localStorage (session names, project names, drafts) belongs to that origin.
 * The desktop app therefore reuses one port across launches.
 */
export const DESKTOP_PORT = 19383
const PORT_FILE = "desktop-port"

function rememberedPort(userDataDir: string): number {
  try {
    const port = Number(readFileSync(join(userDataDir, PORT_FILE), "utf8").trim())
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DESKTOP_PORT
  } catch {
    return DESKTOP_PORT
  }
}

/** Listen on `port` (0 for any free one) and resolve with the port bound. */
export async function listenOn(server: Server, port: number, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
  const address = server.address()
  return typeof address === "object" && address ? address.port : 0
}

/**
 * Listen on the port the last launch used, falling back to any free port when
 * it is taken, and remember whichever port was bound for the next launch.
 */
export async function listenOnStablePort(server: Server, host: string, userDataDir: string): Promise<number> {
  let port: number
  try {
    port = await listenOn(server, rememberedPort(userDataDir), host)
  } catch {
    port = await listenOn(server, 0, host)
  }
  if (port) {
    try {
      writeFileSync(join(userDataDir, PORT_FILE), String(port))
    } catch { /* the next launch falls back to DESKTOP_PORT */ }
  }
  return port
}
