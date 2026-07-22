import { gzip } from "node:zlib"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { NextFn } from "./http"

/** Bodies smaller than this aren't worth the gzip overhead. */
const MIN_COMPRESS_BYTES = 1024
const COMPRESSIBLE_TYPES = /^(?:application\/json|text\/)/i

function acceptsGzip(req: IncomingMessage): boolean {
  const header = req.headers["accept-encoding"]
  if (typeof header !== "string") return false
  return header.split(",").some((entry) => {
    const [name, ...params] = entry.trim().split(";")
    if (name.trim().toLowerCase() !== "gzip") return false
    const quality = params.map((p) => p.trim()).find((p) => p.startsWith("q="))
    return quality === undefined || Number.parseFloat(quality.slice(2)) > 0
  })
}

function shouldCompress(res: ServerResponse, body: Buffer): boolean {
  if (res.headersSent) return false
  if (res.statusCode === 204 || res.statusCode === 304) return false
  if (res.getHeader("Content-Encoding")) return false
  if (body.byteLength < MIN_COMPRESS_BYTES) return false
  const type = res.getHeader("Content-Type")
  return typeof type === "string" && COMPRESSIBLE_TYPES.test(type)
}

/**
 * Gzip single-shot JSON/text API responses when the client advertises gzip
 * support. Remote access (Cloudflare tunnel, LAN) pays for every response
 * byte on the origin uplink, so megabyte-class session payloads must not
 * leave the server uncompressed.
 *
 * Streaming responses (SSE watchers, pipes) call res.write before res.end;
 * the first write marks the response as streaming and everything passes
 * through untouched and unbuffered.
 */
export function compressionMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): void {
  if (req.method === "HEAD" || !acceptsGzip(req)) {
    next()
    return
  }

  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)
  let streaming = false

  res.write = ((...args: Parameters<typeof originalWrite>) => {
    streaming = true
    return originalWrite(...args)
  }) as typeof res.write

  res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
    const done =
      typeof encoding === "function" ? (encoding as () => void)
      : typeof callback === "function" ? (callback as () => void)
      : undefined
    const body =
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8")
        : Buffer.isBuffer(chunk) ? chunk
        : null

    if (streaming || body === null || !shouldCompress(res, body)) {
      return originalEnd(chunk as never, encoding as never, callback as never)
    }

    gzip(body, (error, compressed) => {
      if (error || res.headersSent) {
        originalEnd(body, done)
        return
      }
      res.setHeader("Content-Encoding", "gzip")
      res.setHeader("Vary", "Accept-Encoding")
      res.setHeader("Content-Length", String(compressed.byteLength))
      originalEnd(compressed, done)
    })
    return res
  }) as typeof res.end

  next()
}
