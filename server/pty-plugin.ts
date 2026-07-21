import type { Plugin, ViteDevServer } from "vite"
import { WebSocketServer } from "ws"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { websocketUpgradeRejection } from "./security"
import { handleHubUpgrade } from "./hub/proxy"
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
          if (handleHubUpgrade(req, socket, head)) return
          const url = new URL(req.url || "/", "http://localhost")
          if (url.pathname !== "/__pty") return

          const rejection = websocketUpgradeRejection(req, url)
          if (rejection) {
            const reason = rejection === 401 ? "Unauthorized" : "Forbidden"
            socket.write(`HTTP/1.1 ${rejection} ${reason}\r\n\r\n`)
            socket.destroy()
            return
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
