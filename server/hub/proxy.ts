import { request as httpRequest, type IncomingMessage, type ServerResponse, type ClientRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http"
import { request as httpsRequest } from "node:https"
import type { Duplex } from "node:stream"

import { getDevice, sameDeviceConnection, type HubDevice } from "./registry"
import {
  getDeviceTokenLease,
  invalidateDeviceTokenGeneration,
  DeviceAuthError,
  type DeviceTokenLease,
} from "./device-client"
import { onDeviceConnectionsInvalidated } from "./connection-invalidation"
import { rejectWebsocketUpgrade } from "../security"
import type { NextFn } from "../http"
import { isTeamEdition } from "../team/edition"
import { requirementFor } from "../team/policy"
import { getRequestPrincipal } from "../team/requestPrincipal"

/**
 * Multi-device hub reverse proxy.
 *
 * Mounted as `use("/hub", handler)` in both shells (Electron Express + Vite
 * connect). Both strip the mount prefix, so requests arrive here with
 * `req.url === "/:deviceId/rest..."`. The proxy resolves the device by opaque
 * registry id (never a host from the URL — SSRF guard), injects the device's
 * own session token, and streams the response back raw so SSE flushes through.
 *
 * Two hard invariants from the plan drive the odd bits below:
 *  - A device-side 401 must NEVER reach the browser as a 401 (it would nuke the
 *    hub token and flip the whole app to LoginScreen). Device auth failures are
 *    mapped to `502 {code: "DEVICE_AUTH_FAILED"}` after one single-flight
 *    re-mint + replay of the buffered request.
 *  - No idle timeout on the upstream request: `send-message` holds the response
 *    open for minutes. Only a short *connect-phase* watchdog guards liveness.
 */

// ── Tuning ───────────────────────────────────────────────────────────

/** Give up if the device hasn't accepted the TCP connection / first byte by this. */
const CONNECT_WATCHDOG_MS = 7000

// ── Hop-by-hop header sets ───────────────────────────────────────────

/** Stripped from the request we send to the device (recomputed or hub-specific). */
const OUTBOUND_STRIP = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "connection",
  "upgrade",
  "keep-alive",
  "accept-encoding",
  "content-length",
  // Body is fully buffered and re-sent with an explicit content-length; a
  // leftover chunked framing header would contradict it.
  "transfer-encoding",
])

/** Stripped from the device response before it reaches the browser. */
const RESPONSE_STRIP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
  // A downstream device must never be able to mint or overwrite the hub's
  // origin-scoped browser session cookie.
  "set-cookie",
])

// ── Small helpers ────────────────────────────────────────────────────

interface JsonError {
  error: string
  code: string
}

function sendJson(res: ServerResponse, status: number, payload: JsonError, deviceId?: string): void {
  if (res.headersSent) return
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  // The client attributes a 502 to the active remote device via this header
  // (auth.ts dispatches `cogpit-device-unreachable`), so stamp it on every
  // response we generate for a resolved device — errors included.
  if (deviceId) res.setHeader("X-Cogpit-Device", deviceId)
  res.end(JSON.stringify(payload))
}

/**
 * Drop only the hub's own `token` query param, preserving every other param and
 * its original percent-encoding. Keys are decoded solely for the comparison.
 */
function stripHubToken(rawQuery: string): string {
  if (!rawQuery) return ""
  return rawQuery
    .split("&")
    .filter((pair) => {
      if (!pair) return false
      const eq = pair.indexOf("=")
      const rawKey = eq === -1 ? pair : pair.slice(0, eq)
      let key = rawKey
      try {
        key = decodeURIComponent(rawKey)
      } catch {
        // Malformed encoding — compare against the raw key instead.
      }
      return key !== "token"
    })
    .join("&")
}

function buildOutboundHeaders(incoming: IncomingHttpHeaders, body: Buffer, token: string | null, device: HubDevice): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (OUTBOUND_STRIP.has(key.toLowerCase())) continue
    headers[key] = value
  }
  headers["content-length"] = String(body.length)
  if (device.auth === "password" && token) {
    headers["Authorization"] = `Bearer ${token}`
  }
  return headers
}

function filterResponseHeaders(incoming: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (RESPONSE_STRIP.has(key.toLowerCase())) continue
    out[key] = value
  }
  return out
}

function normalizedDownstreamPath(downstreamPath: string): string | null {
  try {
    // URL parsing collapses literal and encoded dot segments. Decode the
    // resulting pathname as well so encoded route names cannot bypass a hub
    // boundary that the downstream router would later decode.
    const decoded = decodeURIComponent(new URL(downstreamPath, "http://cogpit.invalid").pathname)
    // Decoding an encoded slash/backslash can reveal dot segments that were
    // not segments during the first parse. Normalize once more after decode.
    return new URL(decoded, "http://cogpit.invalid").pathname.toLowerCase()
  } catch {
    return null
  }
}

/** Device auth/session routes must never receive the hub's service token. */
export function isForbiddenHubDownstreamPath(downstreamPath: string): boolean {
  const path = normalizedDownstreamPath(downstreamPath)
  return path === "/api/auth" || path?.startsWith("/api/auth/") === true
}

/**
 * The outer `/hub/:deviceId` policy only proves that the caller may use the
 * proxy. In team edition the downstream API path must still be authorized as
 * that caller before the hub replaces their credential with a device-admin
 * token. Personal edition intentionally keeps its existing proxy behaviour.
 */
export function hubProxyAuthorizationRejection(
  req: IncomingMessage,
  downstreamPath: string,
  method: string,
): 401 | 403 | null {
  if (!isTeamEdition()) return null
  const principal = getRequestPrincipal(req)
  if (!principal) return 401
  // Malformed paths fall through to the policy table's admin default.
  const policyPath = normalizedDownstreamPath(downstreamPath) ?? "/api/__invalid-hub-path"
  return requirementFor(policyPath, method.toUpperCase()) === "admin"
    && principal.role !== "admin"
    ? 403
    : null
}

// ── HTTP proxy handler ───────────────────────────────────────────────

/**
 * Connect/Express-style middleware compatible with both `app.use("/hub", h)`
 * and `server.middlewares.use("/hub", h)`. It NEVER calls `next()` into the SPA
 * fallback: an unmatched hub path is a hard JSON 404, not HTML.
 */
export function createHubProxyHandler(): (req: IncomingMessage, res: ServerResponse, next: NextFn) => void {
  return function hubProxy(req: IncomingMessage, res: ServerResponse, _next: NextFn): void {
    void _next // hub paths never fall through to the SPA fallback

    const url = req.url || "/"
    const qIndex = url.indexOf("?")
    const rawPath = qIndex === -1 ? url : url.slice(0, qIndex)
    const rawQuery = qIndex === -1 ? "" : url.slice(qIndex + 1)

    const withoutLeading = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath
    const slash = withoutLeading.indexOf("/")
    const deviceId = slash === -1 ? withoutLeading : withoutLeading.slice(0, slash)
    // `rest` keeps its leading slash: "/api/sessions".
    const rest = slash === -1 ? "" : withoutLeading.slice(slash)

    const device = deviceId ? getDevice(deviceId) : undefined
    if (!device) {
      return sendJson(res, 404, { error: `Unknown device "${deviceId}"`, code: "UNKNOWN_DEVICE" })
    }

    if (!rest.startsWith("/api/")) {
      // Also blocks /hub/x/hub/y recursion and any non-API surface.
      return sendJson(res, 404, { error: "Hub requests must target /api/*", code: "BAD_HUB_PATH" }, device.id)
    }

    if (isForbiddenHubDownstreamPath(rest)) {
      return sendJson(res, 403, {
        error: "Device authentication routes cannot be proxied",
        code: "HUB_AUTH_ROUTE_FORBIDDEN",
      }, device.id)
    }

    const method = (req.method || "GET").toUpperCase()
    const authorizationRejection = hubProxyAuthorizationRejection(req, rest, method)
    if (authorizationRejection) {
      return sendJson(
        res,
        authorizationRejection,
        authorizationRejection === 401
          ? { error: "Authentication required", code: "AUTH_REQUIRED" }
          : { error: "Admin access required", code: "FORBIDDEN" },
        device.id,
      )
    }
    if (method !== "GET" && method !== "HEAD" && !req.headers["x-cogpit-client"]) {
      return sendJson(res, 403, { error: "Missing X-Cogpit-Client header", code: "MISSING_CLIENT_HEADER" }, device.id)
    }

    // Buffer the request body fully so it can be replayed once after a token
    // re-mint. bodySizeLimit (5MB) already runs upstream of this handler.
    const chunks: Buffer[] = []
    let requestFailed = false
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on("error", () => {
      requestFailed = true
    })
    req.on("end", () => {
      if (requestFailed) return
      // Do not carry the admission-time device snapshot across a slow request
      // body. An admin may have changed its host or credentials meanwhile.
      dispatch(req, res, device.id, method, rest, rawQuery, Buffer.concat(chunks))
    })
  }
}

function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  deviceId: string,
  method: string,
  rest: string,
  rawQuery: string,
  body: Buffer,
): void {
  const strippedQuery = stripHubToken(rawQuery)
  const outboundPath = rest + (strippedQuery ? `?${strippedQuery}` : "")

  // `responded` guards the single client-facing outcome: either a JSON error or
  // the start of a piped response. Once set, later errors only tear down.
  let responded = false
  let invalidated = false
  let currentProxyReq: ClientRequest | null = null
  let currentProxyRes: IncomingMessage | null = null
  let unsubscribeInvalidation = (): void => {}

  const cleanupInvalidation = (): void => unsubscribeInvalidation()
  unsubscribeInvalidation = onDeviceConnectionsInvalidated((changedDeviceId) => {
    if (changedDeviceId !== deviceId || invalidated) return
    invalidated = true
    currentProxyReq?.destroy()
    currentProxyRes?.destroy()
    if (responded || res.headersSent) {
      if (!res.writableEnded) res.destroy()
    } else {
      failGateway("DEVICE_CONNECTION_CHANGED", "Device connection settings changed")
    }
  })
  res.once("finish", cleanupInvalidation)

  // Client went away before we finished → tear down the upstream (no leaked
  // sockets). res 'close' with writableFinished === true is a normal finish and
  // needs no action. NOTE: we deliberately do NOT key off req 'close': for a GET
  // the request stream closes ~immediately after 'end', long before the response
  // is done — using it would abort every streaming request.
  res.on("close", () => {
    cleanupInvalidation()
    if (!res.writableFinished) {
      currentProxyReq?.destroy()
      currentProxyRes?.destroy()
    }
  })

  function failGateway(code: string, message: string): void {
    if (responded) {
      // Already piping — the client committed to a status; just tear down.
      if (!res.writableEnded) res.destroy()
      return
    }
    responded = true
    sendJson(res, 502, { error: message, code }, deviceId)
  }

  function failUnknownDevice(): void {
    if (responded) {
      if (!res.writableEnded) res.destroy()
      return
    }
    responded = true
    sendJson(res, 404, { error: `Unknown device "${deviceId}"`, code: "UNKNOWN_DEVICE" }, deviceId)
  }

  function attempt(device: HubDevice, lease: DeviceTokenLease, allowRetry: boolean): void {
    if (invalidated) return
    const requestFn = device.tls ? httpsRequest : httpRequest
    const proxyReq = requestFn({
      hostname: device.host,
      port: device.port,
      method,
      path: outboundPath,
      headers: buildOutboundHeaders(req.headers, body, lease.token, device),
    })
    currentProxyReq = proxyReq
    // No idle timeout: send-message holds the response open for minutes.
    proxyReq.setTimeout(0)

    let connectSettled = false
    const watchdog = setTimeout(() => {
      if (connectSettled) return
      connectSettled = true
      proxyReq.destroy()
      failGateway("DEVICE_UNREACHABLE", `Device "${device.name}" did not respond in time`)
    }, CONNECT_WATCHDOG_MS)
    const clearWatchdog = (): void => {
      if (!connectSettled) {
        connectSettled = true
        clearTimeout(watchdog)
      }
    }

    proxyReq.on("socket", (socket) => {
      if (socket.connecting) socket.once("connect", clearWatchdog)
      else clearWatchdog()
    })

    proxyReq.on("response", (proxyRes) => {
      clearWatchdog()
      currentProxyRes = proxyRes
      if (invalidated) {
        proxyRes.destroy()
        return
      }

      if (proxyRes.statusCode === 401 && allowRetry) {
        // Device token expired/rotated: drain, re-mint once (single-flight in
        // device-client), and replay the buffered request exactly once.
        proxyRes.resume()
        const retryDevice = getDevice(deviceId)
        if (!retryDevice) return failUnknownDevice()
        if (retryDevice.auth === "password") {
          invalidateDeviceTokenGeneration(deviceId, lease.generation)
          resolveTokenAndAttempt(false)
          return
        }
      }

      if (proxyRes.statusCode === 401) {
        // Second 401 (or an auth:"none" device) — a 401 must never reach the
        // browser, so it becomes a typed 502 instead.
        proxyRes.resume()
        failGateway("DEVICE_AUTH_FAILED", `Device "${device.name}" rejected the hub credentials`)
        return
      }

      // Every other status (403/503 included) passes through verbatim.
      if (responded) {
        proxyRes.destroy()
        return
      }
      responded = true

      const headers = filterResponseHeaders(proxyRes.headers)
      headers["X-Cogpit-Device"] = device.id
      res.writeHead(proxyRes.statusCode || 502, headers)
      // Raw pipe — no buffering, no compression anywhere in the chain, so SSE
      // chunks flush straight through.
      proxyRes.pipe(res)
      proxyRes.on("close", () => {
        if (!res.writableEnded) res.end()
      })
      proxyRes.on("error", () => {
        if (!res.writableEnded) res.destroy()
      })
    })

    proxyReq.on("error", (err: NodeJS.ErrnoException) => {
      clearWatchdog()
      void err
      failGateway("DEVICE_UNREACHABLE", `Device "${device.name}" is unreachable`)
    })

    proxyReq.end(body)
  }

  function resolveTokenAndAttempt(allowRetry: boolean): void {
    const snapshot = getDevice(deviceId)
    if (!snapshot) return failUnknownDevice()

    getDeviceTokenLease(snapshot)
      .then((lease) => {
        if (invalidated) return
        const current = getDevice(deviceId)
        if (!current) return failUnknownDevice()
        if (!sameDeviceConnection(snapshot, current)) {
          // The generation guard rejects changes during a mint. This second
          // comparison closes the smaller gap between a resolved token and the
          // actual outbound request (and covers auth:none, which does not mint).
          resolveTokenAndAttempt(allowRetry)
          return
        }
        attempt(current, lease, allowRetry)
      })
      .catch((err) => {
        if (invalidated) return
        if (err instanceof DeviceAuthError) {
          failGateway("DEVICE_AUTH_FAILED", `Device "${snapshot.name}" rejected the hub credentials`)
        } else {
          failGateway("DEVICE_UNREACHABLE", `Device "${snapshot.name}" is unreachable`)
        }
      })
  }

  // Resolve after the request body is complete, mint (or reuse) the token, and
  // verify that the registry snapshot is still current before connecting.
  resolveTokenAndAttempt(true)
}

// ── WebSocket upgrade proxy ──────────────────────────────────────────

/**
 * Proxy a `/hub/:deviceId/__pty` WebSocket upgrade to the target device.
 *
 * Returns `false` immediately when the path is not a hub PTY upgrade (the caller
 * falls through to its other upgrade branches). Returns `true` the moment this
 * function owns the socket — including every error path — so the caller must not
 * touch the socket afterwards.
 */
export function handleHubUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(req.url || "/", "http://localhost")
  const match = /^\/hub\/([^/]+)\/__pty$/.exec(url.pathname)
  if (!match) return false

  const deviceId = match[1]

  // Hub-side trust check FIRST — identical semantics to the local /__pty branch.
  if (rejectWebsocketUpgrade(req, url, socket)) return true

  if (!getDevice(deviceId)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n")
    socket.destroy()
    return true
  }

  // Mint asynchronously; we already own the socket, so return true now.
  void openDeviceUpgrade(req, socket, head, deviceId)
  return true
}

function writeSocketError(socket: Duplex, line: string): void {
  if (!socket.destroyed) {
    socket.write(`HTTP/1.1 ${line}\r\n\r\n`)
    socket.destroy()
  }
}

async function openDeviceUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deviceId: string): Promise<void> {
  let invalidated = false
  let currentProxyReq: ClientRequest | null = null
  let currentProxySocket: Duplex | null = null
  let unsubscribeInvalidation = (): void => {}

  const closeTransport = (): void => {
    if (invalidated) return
    invalidated = true
    unsubscribeInvalidation()
    currentProxyReq?.destroy()
    currentProxySocket?.destroy()
    socket.destroy()
  }
  unsubscribeInvalidation = onDeviceConnectionsInvalidated((changedDeviceId) => {
    if (changedDeviceId === deviceId) closeTransport()
  })
  socket.once("close", () => {
    unsubscribeInvalidation()
    currentProxyReq?.destroy()
    currentProxySocket?.destroy()
  })

  const buildUpgradeHeaders = (device: HubDevice): OutgoingHttpHeaders => {
    const headers: OutgoingHttpHeaders = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      // The device authenticates from the query param only; the hub host/token
      // must be rewritten. Everything else (connection/upgrade + sec-websocket-*)
      // passes through so the WS handshake completes.
      if (
        lower === "host"
        || lower === "authorization"
        || lower === "cookie"
        || lower === "origin"
        || lower === "referer"
        || lower.startsWith("sec-fetch-")
      ) continue
      headers[key] = value
    }
    // Omit the default https port: TLS-terminating proxies (e.g. Cloudflare)
    // route on an exact Host match.
    headers["host"] = device.tls && device.port === 443 ? device.host : `${device.host}:${device.port}`
    return headers
  }

  const attemptUpgrade = (device: HubDevice, lease: DeviceTokenLease, allowRetry: boolean): void => {
    if (invalidated || socket.destroyed) return
    // auth:"none" devices read no token; password devices carry it in the query.
    const devicePath = lease.token ? `/__pty?token=${encodeURIComponent(lease.token)}` : "/__pty"
    const requestFn = device.tls ? httpsRequest : httpRequest
    const proxyReq = requestFn({
      hostname: device.host,
      port: device.port,
      method: "GET",
      path: devicePath,
      headers: buildUpgradeHeaders(device),
    })
    currentProxyReq = proxyReq

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      currentProxyReq = null
      if (invalidated || socket.destroyed) {
        proxySocket.destroy()
        return
      }
      currentProxySocket = proxySocket
      // Splice: replay the device's 101 to the client, then bridge both ways.
      const statusLine = `HTTP/1.1 101 ${proxyRes.statusMessage || "Switching Protocols"}\r\n`
      const headerLines = Object.entries(proxyRes.headers)
        .filter(([key, value]) => value !== undefined && key.toLowerCase() !== "set-cookie")
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("\r\n")
      socket.write(statusLine + headerLines + "\r\n\r\n")
      if (proxyHead && proxyHead.length) socket.write(proxyHead)
      if (head && head.length) proxySocket.write(head)

      proxySocket.pipe(socket)
      socket.pipe(proxySocket)
      if ("setKeepAlive" in socket && typeof socket.setKeepAlive === "function") {
        socket.setKeepAlive(true, 30000)
      }
      proxySocket.setKeepAlive(true, 30000)

      const teardown = (): void => {
        proxySocket.destroy()
        socket.destroy()
      }
      socket.on("error", teardown)
      socket.on("close", teardown)
      proxySocket.on("error", teardown)
      proxySocket.on("close", teardown)
    })

    proxyReq.on("response", (proxyRes) => {
      currentProxyReq = null
      // Device answered without upgrading (non-101).
      if (proxyRes.statusCode === 401 && allowRetry) {
        proxyRes.resume()
        const retryDevice = getDevice(deviceId)
        if (!retryDevice) return writeSocketError(socket, "404 Not Found")
        if (retryDevice.auth === "password") {
          invalidateDeviceTokenGeneration(deviceId, lease.generation)
          resolveTokenAndUpgrade(false)
          return
        }
      }
      proxyRes.resume()
      writeSocketError(socket, "502 Bad Gateway")
    })

    proxyReq.on("error", () => {
      currentProxyReq = null
      writeSocketError(socket, "502 Bad Gateway")
    })
    proxyReq.end()
  }

  const resolveTokenAndUpgrade = (allowRetry: boolean): void => {
    const snapshot = getDevice(deviceId)
    if (!snapshot) return writeSocketError(socket, "404 Not Found")

    getDeviceTokenLease(snapshot)
      .then((lease) => {
        if (invalidated || socket.destroyed) return
        const current = getDevice(deviceId)
        if (!current) return writeSocketError(socket, "404 Not Found")
        if (!sameDeviceConnection(snapshot, current)) {
          resolveTokenAndUpgrade(allowRetry)
          return
        }
        attemptUpgrade(current, lease, allowRetry)
      })
      .catch(() => writeSocketError(socket, "502 Bad Gateway"))
  }

  resolveTokenAndUpgrade(true)
}
