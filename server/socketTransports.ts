import type { EventEmitter } from "node:events"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocketServer } from "ws"

import { BrowserViewerManager } from "./browser/viewerSocket"
import { handleHubUpgrade } from "./hub/proxy"
import { PtyAuthorizationController } from "./pty-authorization"
import { PtySocketRelay } from "./pty-socket"
import { rejectWebsocketUpgrade } from "./security"

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

export interface SocketTransportOptions {
  /**
   * Takes the upgrades no Cogpit transport claims. Without one they are left
   * to the server's other `upgrade` listeners, such as Vite's HMR socket.
   */
  fallback?: UpgradeHandler
}

export interface SocketTransports {
  /** End every socket this handler accepted and close its servers. */
  close(): Promise<void>
}

const HUB_TRANSPORT_PATH = /^\/hub\/[^/]+\/(__pty|__browser)$/

/**
 * The one WebSocket upgrade handler every server composition installs: the
 * hub proxy, then the terminal (`/__pty`) and browser viewer (`/__browser`)
 * transports behind the same trust policy as HTTP.
 */
export function attachSocketTransports(httpServer: Pick<EventEmitter, "on">, { fallback }: SocketTransportOptions = {}): SocketTransports {
  const ptyWss = new WebSocketServer({ noServer: true })
  const ptySockets = new PtySocketRelay()
  const browserWss = new WebSocketServer({ noServer: true })
  const browserManager = new BrowserViewerManager()
  const authorization = new PtyAuthorizationController()
  const upgradedSockets = new Set<Duplex>()

  const track = (socket: Duplex) => {
    upgradedSockets.add(socket)
    socket.once("close", () => upgradedSockets.delete(socket))
  }

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL
    try {
      url = new URL(req.url || "/", "http://localhost")
    } catch {
      // A target such as `//` is not a URL; nobody signed in has been asked yet.
      socket.destroy()
      return
    }
    if (handleHubUpgrade(req, socket, head)) {
      track(socket)
      // Hub transport upgrades bypass the local WebSocketServers and splice raw
      // sockets, so track the caller's outer sign-in session here as well.
      if (!socket.destroyed && HUB_TRANSPORT_PATH.test(url.pathname)) {
        authorization.trackHubUpgrade(req, url, socket)
      }
      return
    }
    if (url.pathname === "/__pty" || url.pathname === "/__browser") {
      track(socket)
      if (rejectWebsocketUpgrade(req, url, socket)) return
      const transport = url.pathname === "/__pty" ? ptyWss : browserWss
      transport.handleUpgrade(req, socket, head, (ws) => transport.emit("connection", ws, req))
      return
    }
    if (fallback) {
      track(socket)
      fallback(req, socket, head)
    }
  })

  ptyWss.on("connection", (ws, req) => authorization.handleConnection(ws, req, ptySockets.socketFor(req)))
  browserWss.on("connection", (ws, req) => {
    authorization.handleConnection(ws, req, browserManager.socketFor(req))
  })

  let closed: Promise<void> | null = null
  return {
    close: () => {
      closed ??= (async () => {
        ptySockets.cleanup()
        browserManager.cleanup()
        authorization.cleanup()
        for (const client of ptyWss.clients) client.terminate()
        for (const client of browserWss.clients) client.terminate()
        for (const socket of upgradedSockets) socket.destroy()
        upgradedSockets.clear()
        await Promise.all([
          new Promise<void>((resolve) => ptyWss.close(() => resolve())),
          new Promise<void>((resolve) => browserWss.close(() => resolve())),
        ])
      })()
      return closed
    },
  }
}
