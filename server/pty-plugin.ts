import type { Plugin, ViteDevServer } from "vite"
import { WebSocketServer } from "ws"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { rejectWebsocketUpgrade } from "./security"
import { handleHubUpgrade } from "./hub/proxy"
import { PtySessionManager } from "./pty-server"
import { PtyAuthorizationController } from "./pty-authorization"

export function ptyPlugin(): Plugin {
  return {
    name: "pty-websocket",
    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true })
      const manager = new PtySessionManager(wss)
      const authorization = new PtyAuthorizationController()

      server.httpServer!.on(
        "upgrade",
        (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          const url = new URL(req.url || "/", "http://localhost")
          if (handleHubUpgrade(req, socket, head)) {
            if (/^\/hub\/[^/]+\/__pty$/.test(url.pathname)) {
              authorization.trackHubUpgrade(req, url, socket)
            }
            return
          }
          if (url.pathname !== "/__pty") return

          if (rejectWebsocketUpgrade(req, url, socket)) return

          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req)
          })
        }
      )

      wss.on("connection", (ws, req) => authorization.handleConnection(ws, req, manager))

      // Cleanup on server close
      server.httpServer!.on("close", () => {
        authorization.cleanup()
        manager.cleanup()
      })
    },
  }
}
