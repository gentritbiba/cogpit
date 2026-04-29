import type { Plugin, ViteDevServer } from "vite"
import { WebSocketServer } from "ws"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { getConfig } from "./config"
import { isLocalRequest, validateSessionToken } from "./helpers"
import { PtySessionManager } from "./pty-server"

export function ptyPlugin(): Plugin {
  return {
    name: "pty-websocket",
    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true })
      const manager = new PtySessionManager(wss)

      server.httpServer!.on(
        "upgrade",
        (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          const url = new URL(req.url || "/", "http://localhost")
          if (url.pathname !== "/__pty") return

          // Auth check for remote WebSocket connections
          if (!isLocalRequest(req)) {
            const cfg = getConfig()
            const token = url.searchParams.get("token")
            if (!cfg?.networkAccess || !cfg?.networkPassword || !token || !validateSessionToken(token)) {
              socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
              socket.destroy()
              return
            }
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req)
          })
        }
      )

      wss.on("connection", (ws) => manager.handleConnection(ws))

      // Cleanup on server close
      server.httpServer!.on("close", () => manager.cleanup())
    },
  }
}
