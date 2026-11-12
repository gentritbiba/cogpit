import type { IncomingMessage } from "node:http"
import { WebSocket, type RawData } from "ws"

import { coreHeaders } from "./forward"
import { whenCoreReady } from "./supervisor"

/** Client frames buffered while the core socket connects, before the relay gives up. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024
const CLOSE_INTERNAL_ERROR = 1011
const CLOSE_TOO_BIG = 1009

export interface CoreSocketRelay {
  /**
   * Close the client with this code, and the core socket behind it. Use it
   * for decisions TS makes on its own, such as 1008 when authorization is
   * revoked; the core's own close code never overrides it.
   */
  close(code: number, reason?: string): void
}

export interface CoreRelayHooks {
  /**
   * Runs on every client frame as it arrives, including frames buffered while
   * the core socket connects. Return the frame to send (a string goes as text),
   * or null to drop it.
   */
  toCore?(data: RawData, isBinary: boolean): RawData | string | null
  /** Runs on every core frame before it reaches the client; false drops it. */
  toClient?(data: RawData, isBinary: boolean): boolean
}

/** A received close code that may also be sent: 1005, 1006 and 1015 never go on the wire. */
function sendableCode(code: number, fallback: number): number {
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) {
    return code
  }
  return fallback
}

function size(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.length, 0)
  return data instanceof ArrayBuffer ? data.byteLength : data.length
}

/**
 * Relay a WebSocket that TS has already accepted and authorized to core at
 * `corePath`, frame for frame in both directions. TS stays the endpoint the
 * client sees: it may inspect or refuse frames before calling this, and it
 * ends the conversation with its own close code through the returned handle.
 * The hooks let TS authorize or rewrite each frame in flight.
 */
export function relayToCore(
  client: WebSocket,
  req: IncomingMessage,
  corePath: string,
  hooks: CoreRelayHooks = {},
): CoreSocketRelay {
  let upstream: WebSocket | null = null
  let closing = false
  let pendingBytes = 0
  const pending: { data: RawData | string; isBinary: boolean }[] = []

  const close = (code: number, reason = "") => {
    if (closing) return
    closing = true
    pending.length = 0
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason)
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close(1000)
    else upstream?.terminate()
  }

  client.on("message", (received, isBinary) => {
    if (closing) return
    let data: RawData | string | null
    try {
      data = hooks.toCore ? hooks.toCore(received, isBinary) : received
    } catch {
      close(CLOSE_INTERNAL_ERROR)
      return
    }
    // A hook may have closed the relay itself, as an authorization failure does.
    if (data === null || closing) return
    if (typeof data === "string") isBinary = false
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary })
      return
    }
    pendingBytes += typeof data === "string" ? Buffer.byteLength(data) : size(data)
    if (pendingBytes > MAX_PENDING_BYTES) {
      close(CLOSE_TOO_BIG, "Too much data before the core connected")
      return
    }
    pending.push({ data, isBinary })
  })
  client.on("close", (code, reason) => {
    if (closing) return
    closing = true
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close(sendableCode(code, 1000), reason)
    else upstream?.terminate()
  })
  client.on("error", () => close(CLOSE_INTERNAL_ERROR))

  void whenCoreReady().then(
    (endpoint) => {
      if (closing) return
      const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}${corePath}`, {
        headers: coreHeaders(endpoint, req),
        perMessageDeflate: false,
      })
      upstream = socket
      socket.on("open", () => {
        for (const frame of pending.splice(0)) socket.send(frame.data, { binary: frame.isBinary })
        pendingBytes = 0
      })
      socket.on("message", (data, isBinary) => {
        if (closing || client.readyState !== WebSocket.OPEN) return
        let deliver: boolean
        try {
          deliver = hooks.toClient ? hooks.toClient(data, isBinary) : true
        } catch {
          close(CLOSE_INTERNAL_ERROR)
          return
        }
        if (deliver && !closing) client.send(data, { binary: isBinary })
      })
      socket.on("close", (code, reason) => {
        if (closing) return
        closing = true
        if (client.readyState === WebSocket.OPEN) client.close(sendableCode(code, CLOSE_INTERNAL_ERROR), reason)
      })
      socket.on("error", () => close(CLOSE_INTERNAL_ERROR, "Cogpit core connection failed"))
    },
    () => close(CLOSE_INTERNAL_ERROR, "Cogpit core is not running"),
  )

  return { close }
}
