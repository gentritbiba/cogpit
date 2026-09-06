import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket } from "ws"

import {
  getRequestSessionToken,
  getSessionPrincipal,
  isSessionTokenActive,
  isTrustedDirectLocalRequest,
  onSessionRevoked,
  validateSessionToken,
} from "./security"
import { isTeamEdition } from "./team/edition"

const AUTHORIZATION_RECHECK_MS = 5_000

/** `touch=true` only for client activity; a periodic recheck must not keep a session alive. */
export type SocketAuthorizer = (touch: boolean) => boolean

/**
 * A socket manager this controller can hand an authorized connection to:
 * `PtySessionManager`, and `BrowserViewerManager` with its upgrade request
 * already bound.
 */
export interface AuthorizableSocketManager {
  handleConnection(ws: WebSocket, authorize?: SocketAuthorizer): void
}

function createPtyAuthorizer(token: string, userAgent?: string): SocketAuthorizer {
  return (touch) => {
    try {
      if (touch && !validateSessionToken(token, userAgent)) return false
      return isTeamEdition()
        ? getSessionPrincipal(token)?.role === "admin"
        : isSessionTokenActive(token)
    } catch {
      return false
    }
  }
}

function sessionTokenForUpgrade(req: IncomingMessage, url: URL): string | null {
  return getRequestSessionToken(req) ?? url.searchParams.get("token")
}

function requestRequiresSession(req: IncomingMessage): boolean {
  return isTeamEdition() || !isTrustedDirectLocalRequest(req)
}

/**
 * Tracks the authorization attached to long-lived socket transports (the PTY
 * and the browser viewer).
 *
 * Upgrade validation proves only that a session was valid at handshake time.
 * This controller also closes established local WebSockets and raw hub tunnels
 * when the session is revoked, disabled/demoted, or expires. Trusted direct
 * local transports in personal edition intentionally retain their passwordless
 * desktop/dev behavior.
 */
export class PtyAuthorizationController {
  private readonly ptyTokens = new Map<WebSocket, string>()
  private readonly hubTokens = new Map<Duplex, {
    token: string
    timer: ReturnType<typeof setInterval>
  }>()
  private readonly unsubscribeSessionRevocation: () => void

  constructor() {
    this.unsubscribeSessionRevocation = onSessionRevoked((revokedToken) => {
      for (const [ws, token] of this.ptyTokens) {
        if (revokedToken === null || revokedToken === token) {
          ws.close(1008, "Session authorization revoked")
        }
      }
      for (const [socket, connection] of this.hubTokens) {
        if (revokedToken === null || revokedToken === connection.token) socket.destroy()
      }
    })
  }

  handleConnection(ws: WebSocket, req: IncomingMessage, manager: AuthorizableSocketManager): void {
    if (!requestRequiresSession(req)) {
      manager.handleConnection(ws)
      return
    }

    const url = new URL(req.url || "/", "http://localhost")
    const token = sessionTokenForUpgrade(req, url)
    if (!token) {
      ws.close(1008, "Session authorization missing")
      return
    }

    this.ptyTokens.set(ws, token)
    ws.once("close", () => this.ptyTokens.delete(ws))
    const browserUserAgent = req.headers.origin ? req.headers["user-agent"] : undefined
    manager.handleConnection(ws, createPtyAuthorizer(token, browserUserAgent))
  }

  /** Track a hub upgrade after its initial trust check has accepted the socket. */
  trackHubUpgrade(req: IncomingMessage, url: URL, socket: Duplex): void {
    if (socket.destroyed || !requestRequiresSession(req)) return
    const token = sessionTokenForUpgrade(req, url)
    if (!token) return

    const browserUserAgent = req.headers.origin ? req.headers["user-agent"] : undefined
    const authorize = createPtyAuthorizer(token, browserUserAgent)
    const timer = setInterval(() => {
      if (!authorize(false)) socket.destroy()
    }, AUTHORIZATION_RECHECK_MS)
    timer.unref?.()
    this.hubTokens.set(socket, { token, timer })
    socket.on("data", () => {
      if (!authorize(true)) socket.destroy()
    })
    socket.once("close", () => {
      clearInterval(timer)
      this.hubTokens.delete(socket)
    })
  }

  cleanup(): void {
    this.unsubscribeSessionRevocation()
    for (const connection of this.hubTokens.values()) clearInterval(connection.timer)
    this.hubTokens.clear()
    this.ptyTokens.clear()
  }
}
