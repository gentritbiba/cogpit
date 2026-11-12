import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http"

import { closeInStages, sendJson } from "../http"
import { getRequestPrincipal } from "../requestPrincipal"
import { CORE_PRINCIPAL_HEADER, CORE_SECRET_HEADER } from "./protocol"
import { whenCoreReady, type CoreEndpoint } from "./supervisor"

/** Hop-by-hop headers (RFC 9110 §7.6.1) plus what core must never see from a client. */
const DROPPED_REQUEST_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
  "cookie", "authorization",
  CORE_SECRET_HEADER, CORE_PRINCIPAL_HEADER,
])
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
])

/** The authenticated caller, for core's logs only. Empty under local trust. */
export function principalHeaderValue(req: IncomingMessage): string | undefined {
  const principal = getRequestPrincipal(req)
  return principal ? encodeURIComponent(principal.userId) : undefined
}

/** Headers every request to core carries: the boot secret and the caller. */
export function coreHeaders(endpoint: CoreEndpoint, req: IncomingMessage): Record<string, string> {
  const principal = principalHeaderValue(req)
  return {
    [CORE_SECRET_HEADER]: endpoint.secret,
    ...(principal ? { [CORE_PRINCIPAL_HEADER]: principal } : {}),
  }
}

function requestHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name)) out[name] = value
  }
  return out
}

function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) out[name] = value
  }
  return out
}

/**
 * The query string of the request as the client sent it. Express and Vite
 * strip the mount prefix from `req.url`; `originalUrl` keeps the whole target.
 */
export function originalSearch(req: IncomingMessage): string {
  const target = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? ""
  const query = target.indexOf("?")
  return query === -1 ? "" : target.slice(query)
}

/**
 * Forward this request to core at `corePath` (for example
 * `/v1/files/local-file`), keeping the client's query string, and stream both
 * bodies. TS has already authenticated and authorized the request; core
 * receives the boot secret and, for its logs, the principal.
 *
 * `bodySizeLimit` counts the body as it is piped here. When it refuses one it
 * answers 413 itself (or cuts the response, once core has started one) and
 * closes the connection; the core request is then abandoned.
 */
export async function forwardToCore(req: IncomingMessage, res: ServerResponse, corePath: string): Promise<void> {
  let endpoint: CoreEndpoint
  try {
    endpoint = await whenCoreReady()
  } catch {
    if (!res.headersSent) sendJson(res, 503, { error: "Cogpit core is not running" })
    return
  }
  if (res.writableEnded || req.destroyed) return

  // Transfer-encoding is hop-by-hop, but the body's framing must survive the
  // hop: Node only chunks POST-style methods unasked, and an unframed body on
  // a kept-alive connection would read as the next request.
  const chunked = req.headers["transfer-encoding"] !== undefined
  const hasBody = chunked || Number(req.headers["content-length"] ?? 0) > 0

  await new Promise<void>((done) => {
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: endpoint.port,
      method: req.method,
      path: `${corePath}${originalSearch(req)}`,
      headers: {
        ...requestHeaders(req.headers),
        ...(chunked ? { "transfer-encoding": "chunked" } : {}),
        ...coreHeaders(endpoint, req),
      },
    })

    let abandoned = false
    let answer: IncomingMessage | undefined
    const abandon = () => {
      if (abandoned) return
      abandoned = true
      // Core notices the request ending only while it can still write, so
      // what it has left to say is read and dropped.
      answer?.unpipe(res).resume()
      // A finished exchange has handed its socket back to the agent; an
      // unfinished one is closed so that core is certain to see it go.
      const socket = upstream.socket
      if (upstream.destroyed || !socket || socket.connecting) upstream.destroy()
      else closeInStages(socket)
      done()
    }
    // bodySizeLimit refused the body and closed the connection, or the client left.
    req.once("close", () => {
      if (!req.complete) abandon()
    })
    res.once("close", () => {
      if (!res.writableFinished) abandon()
    })

    upstream.once("response", (upstreamRes) => {
      answer = upstreamRes
      if (abandoned || res.writableEnded || res.headersSent) {
        upstreamRes.resume()
        abandon()
        return
      }
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders(upstreamRes.headers))
      upstreamRes.pipe(res)
      upstreamRes.once("end", () => done())
      upstreamRes.on("error", () => {
        res.destroy()
        done()
      })
    })

    upstream.on("error", () => {
      if (abandoned) return
      if (!res.headersSent) sendJson(res, 502, { error: "Cogpit core request failed" })
      else res.destroy()
      done()
    })

    if (hasBody) {
      req.pipe(upstream)
    } else {
      req.resume()
      upstream.end()
    }
  })
}
