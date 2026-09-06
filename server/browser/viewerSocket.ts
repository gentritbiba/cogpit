/**
 * The `/__browser` transport: one CDP viewer per socket client. Shaped like
 * `PtySessionManager` — same authorizer contract, same 5 s recheck, same 1008
 * close, and the same outbound recheck so a revoked session stops receiving
 * video immediately rather than at the next tick.
 *
 * Each connection is a small state machine. `not-installed` is terminal; the
 * rest cycle `stopped` ⇄ `connecting` → `live`, with a 2 s poll while stopped
 * so a browser the agent opens on its own shows up without user action.
 */
import type { IncomingMessage } from "node:http"
import { WebSocket } from "ws"

import { encodeFrame, type FrameHeader } from "../../shared/browser/frames"
import {
  parseClientMessage,
  type BrowserClientMessage,
  type BrowserServerMessage,
} from "../../shared/browser/protocol"
import { BrowserViewer, type ViewerEvents } from "./cdp"
import { isRunning, launch, readDevToolsEndpoint } from "./daemons"
import { assertNamedBrowser } from "./paths"
import { touchLastUrl } from "./registry"
import { findRealAgentBrowser } from "./shim"

/** The slice of `BrowserViewer` a connection drives, so tests can stand in for it. */
export type BrowserViewerLike = Pick<
  BrowserViewer,
  "setViewport" | "follow" | "mouse" | "wheel" | "key" | "navigate" | "back" | "forward" | "reload" | "close"
>

export interface ViewerSocketDeps {
  installed: () => boolean
  isRunning: (name: string) => Promise<boolean>
  endpoint: (name: string) => { browserWsUrl: string } | null
  openViewer: (wsUrl: string, events: ViewerEvents) => Promise<BrowserViewerLike>
  launch: (name: string, url: string) => Promise<void>
  recordUrl: (name: string, url: string) => void
}

/** `touch=true` only for client activity; the periodic recheck must not keep a session alive. */
export type ViewerConnectionAuthorizer = (touch: boolean) => boolean

type StatusState = Extract<BrowserServerMessage, { type: "status" }>["state"]
type InputMessage = Exclude<BrowserClientMessage, { type: "launch" }>
type ViewportMessage = Extract<BrowserClientMessage, { type: "viewport" }>

const POLL_INTERVAL_MS = 2_000
const AUTHORIZATION_RECHECK_MS = 5_000
const ATTACH_TIMEOUT_MS = 10_000

export const defaultViewerSocketDeps: ViewerSocketDeps = {
  installed: () => findRealAgentBrowser() !== null,
  isRunning: (name) => isRunning(name),
  endpoint: (name) => readDevToolsEndpoint(name),
  openViewer: (wsUrl, events) => BrowserViewer.open(wsUrl, events),
  launch: (name, url) => launch(name, url),
  recordUrl: (name, url) => touchLastUrl(name, url),
}

interface ViewerConnection {
  readonly ws: WebSocket
  readonly session: string
  readonly authorize?: ViewerConnectionAuthorizer
  status: StatusState | null
  lastError: string | null
  viewport: ViewportMessage | null
  viewer: BrowserViewerLike | null
  attaching: boolean
  terminal: boolean
  torn: boolean
  pollTimer: ReturnType<typeof setInterval> | null
  authTimer: ReturnType<typeof setInterval> | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sessionName(req: IncomingMessage): string {
  return new URL(req.url || "/", "http://localhost").searchParams.get("session") ?? ""
}

function closeQuietly(viewer: BrowserViewerLike): void {
  void viewer.close().catch(() => undefined)
}

export class BrowserViewerManager {
  private readonly connections = new Set<ViewerConnection>()

  constructor(private readonly deps: ViewerSocketDeps = defaultViewerSocketDeps) {}

  handleConnection(ws: WebSocket, req: IncomingMessage, authorize?: ViewerConnectionAuthorizer): void {
    let session: string
    try {
      // Inside the guard: an upgrade target like `//[` is a TypeError, not a name.
      session = sessionName(req)
      assertNamedBrowser(session)
    } catch (error) {
      this.sendTo(ws, { type: "error", message: messageOf(error) })
      ws.close(1008, "Invalid browser session")
      return
    }

    const connection: ViewerConnection = {
      ws,
      session,
      authorize,
      status: null,
      lastError: null,
      viewport: null,
      viewer: null,
      attaching: false,
      terminal: false,
      torn: false,
      pollTimer: null,
      authTimer: null,
    }
    this.connections.add(connection)

    if (authorize) {
      connection.authTimer = this.interval(() => this.ensureAuthorized(connection, false), AUTHORIZATION_RECHECK_MS)
    }
    ws.on("message", (raw) => {
      if (!this.ensureAuthorized(connection, true)) return
      this.handleMessage(connection, raw.toString())
    })
    ws.on("close", () => this.teardown(connection))
    ws.on("error", () => this.teardown(connection))

    if (!this.deps.installed()) {
      connection.terminal = true
      this.setStatus(connection, "not-installed")
      return
    }
    void this.sync(connection)
  }

  cleanup(): void {
    for (const connection of [...this.connections]) {
      const { ws } = connection
      this.teardown(connection)
      if (ws.readyState === WebSocket.OPEN) ws.close(1001, "Browser transport shutting down")
    }
  }

  private interval(run: () => void, ms: number): ReturnType<typeof setInterval> {
    const timer = setInterval(run, ms)
    timer.unref?.()
    return timer
  }

  private ensureAuthorized(connection: ViewerConnection, touch: boolean): boolean {
    const { authorize } = connection
    if (!authorize) return true
    try {
      if (authorize(touch)) return true
    } catch {
      // Authorization checks fail closed; a timer callback must never crash the
      // process and leave the privileged transport running.
    }
    if (connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.close(1008, "Session authorization expired")
    }
    this.teardown(connection)
    return false
  }

  private teardown(connection: ViewerConnection): void {
    if (connection.torn) return
    connection.torn = true
    this.stopPolling(connection)
    if (connection.authTimer) clearInterval(connection.authTimer)
    connection.authTimer = null
    const { viewer } = connection
    connection.viewer = null
    if (viewer) closeQuietly(viewer)
    this.connections.delete(connection)
  }

  private canAttach(connection: ViewerConnection): boolean {
    return !connection.torn && !connection.terminal && !connection.attaching && connection.viewer === null
  }

  private async sync(connection: ViewerConnection): Promise<void> {
    if (!this.canAttach(connection)) return
    let running = false
    try {
      running = await this.deps.isRunning(connection.session)
    } catch {
      running = false
    }
    if (!this.canAttach(connection)) return
    if (running) {
      await this.attach(connection)
      return
    }
    this.setStopped(connection)
  }

  private async attach(connection: ViewerConnection): Promise<void> {
    if (!this.canAttach(connection)) return
    this.stopPolling(connection)
    connection.attaching = true
    this.setStatus(connection, "connecting")
    try {
      const endpoint = this.deps.endpoint(connection.session)
      if (endpoint === null) throw new Error(`${connection.session} is not exposing a DevTools endpoint`)
      const viewer = await this.openViewer(connection, endpoint.browserWsUrl)
      if (connection.torn) {
        closeQuietly(viewer)
        return
      }
      connection.viewer = viewer
      connection.lastError = null
      this.setStatus(connection, "live")
      const { viewport } = connection
      if (viewport) await this.deliver(connection, viewer, viewport)
    } catch (error) {
      this.sendError(connection, messageOf(error))
      this.setStopped(connection)
    } finally {
      connection.attaching = false
    }
  }

  /**
   * A Chromium that completes the WebSocket handshake and then never answers
   * would otherwise leave the connection in `connecting` with the poll stopped
   * and no way back. The attempt that timed out disowns its viewer, so one that
   * arrives afterwards is closed instead of adopted.
   */
  private openViewer(connection: ViewerConnection, wsUrl: string): Promise<BrowserViewerLike> {
    return new Promise((resolve, reject) => {
      let expired = false
      const timer = setTimeout(() => {
        expired = true
        reject(new Error(`${connection.session} did not answer in ${ATTACH_TIMEOUT_MS / 1_000}s`))
      }, ATTACH_TIMEOUT_MS)
      timer.unref?.()
      this.deps.openViewer(wsUrl, this.viewerEvents(connection)).then(
        (viewer) => {
          clearTimeout(timer)
          if (expired) closeQuietly(viewer)
          else resolve(viewer)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(messageOf(error)))
        },
      )
    })
  }

  private viewerEvents(connection: ViewerConnection): ViewerEvents {
    return {
      frame: (header, jpeg) => this.sendFrame(connection, header, jpeg),
      tabs: (tabs, followed) => this.send(connection, { type: "tabs", tabs, followed }),
      page: (info) => {
        this.send(connection, { type: "page", ...info })
        try {
          this.deps.recordUrl(connection.session, info.url)
        } catch {
          // Remembering the last url is best effort; a viewer must not die with the registry.
        }
      },
      error: (message) => this.sendError(connection, message),
      closed: (reason) => {
        if (connection.torn) return
        connection.viewer = null
        this.setStopped(connection, reason)
      },
    }
  }

  private handleMessage(connection: ViewerConnection, raw: string): void {
    if (connection.terminal || connection.torn) return
    const message = parseClientMessage(raw)
    if (message === null) return
    if (message.type === "launch") {
      void this.handleLaunch(connection, message.url)
      return
    }
    // Remembered even with no viewer: an attach replays it, so a reattach does
    // not depend on the client noticing and sending its size again.
    if (message.type === "viewport") connection.viewport = message
    const { viewer } = connection
    if (viewer) void this.deliver(connection, viewer, message)
  }

  private async handleLaunch(connection: ViewerConnection, url: string): Promise<void> {
    try {
      await this.deps.launch(connection.session, url)
    } catch (error) {
      this.sendError(connection, messageOf(error))
      return
    }
    await this.attach(connection)
  }

  private async deliver(
    connection: ViewerConnection,
    viewer: BrowserViewerLike,
    message: InputMessage,
  ): Promise<void> {
    try {
      switch (message.type) {
        case "viewport":
          await viewer.setViewport(message.width, message.height, message.dpr)
          break
        case "mouse":
          await viewer.mouse(message)
          break
        case "wheel":
          await viewer.wheel(message)
          break
        case "key":
          await viewer.key(message)
          break
        case "navigate":
          await viewer.navigate(message.url)
          break
        case "back":
          await viewer.back()
          break
        case "forward":
          await viewer.forward()
          break
        case "reload":
          await viewer.reload()
          break
        case "follow":
          await viewer.follow(message.targetId)
          break
        default: {
          // Exhaustiveness guard: a new client message must fail typecheck here
          // rather than being silently dropped by the transport.
          const exhaustive: never = message
          return exhaustive
        }
      }
    } catch (error) {
      this.sendError(connection, messageOf(error))
    }
  }

  private startPolling(connection: ViewerConnection): void {
    if (connection.pollTimer || connection.torn) return
    connection.pollTimer = this.interval(() => void this.sync(connection), POLL_INTERVAL_MS)
  }

  private stopPolling(connection: ViewerConnection): void {
    if (connection.pollTimer) clearInterval(connection.pollTimer)
    connection.pollTimer = null
  }

  private setStopped(connection: ViewerConnection, message?: string): void {
    if (connection.torn || connection.terminal) return
    this.setStatus(connection, "stopped", message)
    this.startPolling(connection)
  }

  private setStatus(connection: ViewerConnection, state: StatusState, message?: string): void {
    if (connection.status === state) return
    connection.status = state
    this.send(connection, { type: "status", state, session: connection.session, ...(message ? { message } : {}) })
  }

  /** Deduped like `status`: an attach that keeps failing every 2 s reports once. */
  private sendError(connection: ViewerConnection, message: string): void {
    if (connection.lastError === message) return
    connection.lastError = message
    this.send(connection, { type: "error", message })
  }

  /**
   * Resolves in the send callback, never on entry: the viewer awaits this
   * before acking Chromium, so a slow client throttles the browser instead of
   * growing an unbounded send buffer. A client that stops reading without
   * closing still settles it, on `close`.
   */
  private sendFrame(connection: ViewerConnection, header: FrameHeader, jpeg: Uint8Array): Promise<void> {
    if (!this.ensureAuthorized(connection, false)) return Promise.resolve()
    const { ws } = connection
    if (ws.readyState !== WebSocket.OPEN) return Promise.resolve()
    return new Promise((resolve) => {
      const settle = (): void => {
        ws.off("close", settle)
        resolve()
      }
      ws.once("close", settle)
      ws.send(encodeFrame(header, jpeg), settle)
    })
  }

  private send(connection: ViewerConnection, message: BrowserServerMessage): void {
    if (!this.ensureAuthorized(connection, false)) return
    this.sendTo(connection.ws, message)
  }

  private sendTo(ws: WebSocket, message: BrowserServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(message))
  }
}
