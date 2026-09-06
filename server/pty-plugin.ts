import type { Plugin, ViteDevServer } from "vite"
import { WebSocketServer } from "ws"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { rejectWebsocketUpgrade } from "./security"
import { handleHubUpgrade } from "./hub/proxy"
import { PtySessionManager } from "./pty-server"
import { PtyAuthorizationController } from "./pty-authorization"
import { BrowserViewerManager } from "./browser/viewerSocket"

export function ptyPlugin(): Plugin {
  return {
    name: "pty-websocket",
    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true })
      const manager = new PtySessionManager(wss)
      const browserWss = new WebSocketServer({ noServer: true })
      const browserManager = new BrowserViewerManager()
      const authorization = new PtyAuthorizationController()

      server.httpServer!.on(
        "upgrade",
        (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          const url = new URL(req.url || "/", "http://localhost")
          if (handleHubUpgrade(req, socket, head)) {
            if (/^\/hub\/[^/]+\/(__pty|__browser)$/.test(url.pathname)) {
              authorization.trackHubUpgrade(req, url, socket)
            }
            return
          }
          if (url.pathname !== "/__pty" && url.pathname !== "/__browser") return

          if (rejectWebsocketUpgrade(req, url, socket)) return

          const transport = url.pathname === "/__pty" ? wss : browserWss
          transport.handleUpgrade(req, socket, head, (ws) => {
            transport.emit("connection", ws, req)
          })
        }
      )

      wss.on("connection", (ws, req) => authorization.handleConnection(ws, req, manager))
      browserWss.on("connection", (ws, req) => {
        authorization.handleConnection(ws, req, browserManager.socketFor(req))
      })

      // Cleanup on server close
      server.httpServer!.on("close", () => {
        authorization.cleanup()
        manager.cleanup()
        browserManager.cleanup()
        for (const client of browserWss.clients) client.terminate()
        browserWss.close()
      })
    },
  }
}
