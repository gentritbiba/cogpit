import WebSocket from "ws"
import { SlackApiError, type SlackCall } from "./api"

/** The part of a WebSocket the client uses, so tests can drive one by hand. */
export interface SocketLike {
  on(event: "open" | "close" | "ping" | "pong", listener: () => void): unknown
  on(event: "message", listener: (data: unknown) => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  send(data: string): void
  ping?(): void
  close(): void
  terminate?(): void
}

export interface SocketModeEnvelope {
  envelope_id?: string
  type?: string
  reason?: string
  payload?: Record<string, unknown>
  retry_attempt?: number
}

export type SocketState = "connecting" | "connected" | "reconnecting" | "stopped" | "failed"

export interface SocketModeOptions {
  /** apps.connections.open, called with the app token. */
  appApi: SlackCall
  /** Resolve to acknowledge; reject and the envelope stays unacknowledged, so Slack sends it again. */
  onEvent: (payload: Record<string, unknown>, envelope: SocketModeEnvelope) => Promise<void>
  log: (message: string) => void
  connect?: (url: string) => SocketLike
  /** Silence after which the connection counts as dead. */
  staleMs?: number
  maxBackoffMs?: number
}

/** Errors that a retry cannot fix: the app token is wrong or the app is gone. */
const FATAL = new Set(["invalid_auth", "not_authed", "account_inactive", "token_revoked", "not_allowed_token_type", "app_deleted"])

/**
 * One Socket Mode connection. Slack refreshes connections every few hours and
 * may drop them at any time; this reconnects with backoff, replaces a socket
 * that has gone silent, and only acknowledges an event once it is safe.
 */
export class SocketModeClient {
  state: SocketState = "stopped"
  lastError?: string
  connectedAt?: number
  private socket: SocketLike | null = null
  private running = false
  private backoffMs = 1000
  private lastActivity = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: SocketModeOptions) {}

  start(): void {
    if (this.running) return
    this.running = true
    const staleMs = this.options.staleMs ?? 90_000
    // A socket that goes quiet, or never reaches hello, is replaced; a live one is pinged so quiet is meaningful.
    this.watchdog = setInterval(() => {
      if (!this.socket) return
      if (Date.now() - this.lastActivity > staleMs) {
        this.options.log(this.state === "connected" ? "Socket Mode connection went silent; reconnecting" : "Socket Mode did not finish connecting; retrying")
        this.reconnect()
      } else if (this.state === "connected") this.socket.ping?.()
    }, Math.max(1000, staleMs / 3))
    this.watchdog.unref?.()
    void this.open()
  }

  stop(): void {
    this.running = false
    this.state = "stopped"
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.watchdog) clearInterval(this.watchdog)
    this.retryTimer = this.watchdog = null
    this.drop()
  }

  private drop(): void {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    try {
      ;(socket.terminate ?? socket.close).call(socket)
    } catch {
      // Already closed.
    }
  }

  private reconnect(): void {
    this.drop()
    if (!this.running) return
    this.state = "reconnecting"
    if (this.retryTimer) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 60_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.open()
    }, delay)
    this.retryTimer.unref?.()
  }

  private async open(): Promise<void> {
    if (!this.running) return
    this.state = this.connectedAt ? "reconnecting" : "connecting"
    let url: string
    try {
      url = String((await this.options.appApi("apps.connections.open")).url)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      if (error instanceof SlackApiError && FATAL.has(error.code)) {
        this.options.log(`Socket Mode cannot connect: ${error.code}; fix the app token and link again`)
        this.state = "failed"
        this.running = false
        if (this.watchdog) clearInterval(this.watchdog)
        return
      }
      this.options.log(`Socket Mode open failed (${this.lastError}); retrying`)
      this.reconnect()
      return
    }
    if (!this.running) return
    const socket = (this.options.connect ?? ((target) => new WebSocket(target) as unknown as SocketLike))(url)
    this.socket = socket
    this.lastActivity = Date.now()
    const current = () => this.socket === socket
    const alive = () => { if (current()) this.lastActivity = Date.now() }
    socket.on("ping", alive)
    socket.on("pong", alive)
    socket.on("message", (data) => { if (current()) void this.receive(socket, data) })
    socket.on("error", (error) => { if (current()) this.lastError = error.message })
    socket.on("close", () => {
      if (!current()) return
      this.options.log("Socket Mode connection closed; reconnecting")
      this.reconnect()
    })
  }

  private async receive(socket: SocketLike, data: unknown): Promise<void> {
    this.lastActivity = Date.now()
    let envelope: SocketModeEnvelope
    try {
      envelope = JSON.parse(String(data)) as SocketModeEnvelope
    } catch {
      return
    }
    switch (envelope.type) {
      case "hello":
        this.state = "connected"
        this.connectedAt = Date.now()
        this.backoffMs = 1000
        this.lastError = undefined
        this.options.log("Socket Mode connected")
        return
      case "disconnect":
        // Slack names a reason (refresh_requested, warning, link_disabled); in each case a fresh connection is the answer.
        this.options.log(`Slack asked to reconnect (${envelope.reason ?? "no reason"})`)
        this.backoffMs = 1000
        this.reconnect()
        return
    }
    if (!envelope.envelope_id) return
    if (envelope.type === "events_api" && envelope.payload) {
      try {
        await this.options.onEvent(envelope.payload, envelope)
      } catch (error) {
        this.options.log(`Event not acknowledged, Slack will resend it: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
    }
    // Slash commands and interactions are not handled, but must still be acknowledged.
    try {
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }))
    } catch {
      // The socket closed; Slack resends unacknowledged envelopes on the next one.
    }
  }
}
