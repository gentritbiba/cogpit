import type { IncomingMessage, ServerResponse } from "node:http"
import { StringDecoder } from "node:string_decoder"

export type NextFn = (err?: unknown) => void
export type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
) => unknown | Promise<unknown>
export type UseFn = (path: string, handler: Middleware) => void

const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024

export class HttpBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413,
  ) {
    super(message)
    this.name = "HttpBodyError"
  }
}

interface ReadJsonBodyOptions {
  allowEmpty?: boolean
  maxBytes?: number
}

/** Read and parse a bounded JSON request body from a Node HTTP stream. */
export function readJsonBody<T = unknown>(
  req: IncomingMessage,
  options: ReadJsonBodyOptions = {},
): Promise<T> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES

  return new Promise((resolve, reject) => {
    let body = ""
    let bytesRead = 0
    let settled = false
    // Buffers a multi-byte character that straddles two chunks, which would
    // otherwise decode to U+FFFD and corrupt the JSON.
    const decoder = new StringDecoder("utf8")

    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      reject(error)
    }

    req.on("data", (chunk: Buffer | string) => {
      if (settled) return
      bytesRead += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength
      if (bytesRead > maxBytes) {
        rejectOnce(new HttpBodyError("Request body too large", 413))
        return
      }
      body += typeof chunk === "string" ? chunk : decoder.write(chunk)
    })
    req.on("end", () => {
      if (settled) return
      settled = true
      body += decoder.end()
      if (!body.trim() && options.allowEmpty) {
        resolve({} as T)
        return
      }
      try {
        resolve(JSON.parse(body) as T)
      } catch {
        reject(new HttpBodyError("Invalid JSON body", 400))
      }
    })
    req.on("error", () => {
      rejectOnce(new HttpBodyError("Failed to read request body", 400))
    })
  })
}

/** Distinguishes a failed read from a body that legitimately parsed to undefined. */
const BODY_FAILED = Symbol("body-failed")

/**
 * Read a JSON body and hand it to a handler.
 *
 * Exists for the many routes written before readJsonBody did, each of which
 * hand-rolled its own `req.on("data")` accumulator. Those copies shared no body
 * size limit and decoded a multi-byte character split across two chunks into
 * U+FFFD. Keeping the callback shape lets a route adopt this without
 * restructuring the handler around it.
 */
export function withJsonBody<T = unknown>(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (body: T) => void | Promise<void>,
  options: ReadJsonBodyOptions = {},
): void {
  void readJsonBody<T>(req, options)
    .catch((error: unknown) => {
      if (!res.headersSent) {
        const bodyError = error instanceof HttpBodyError
        sendJson(res, bodyError ? error.statusCode : 400, {
          error: bodyError ? error.message : "Invalid JSON body",
        })
      }
      return BODY_FAILED
    })
    .then((body) => (body === BODY_FAILED ? undefined : handler(body as T)))
    // The handler owns its own failures; this only covers one that gave up
    // without answering, which would otherwise hang the request.
    .catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "Request failed" })
    })
}

/**
 * Normalize async middleware errors for both Express and Vite's Connect stack.
 * Connect does not observe a returned Promise, so every canonical API handler
 * must explicitly forward rejected work to next(error).
 */
export function catchAsyncErrors(handler: Middleware): Middleware {
  return (req, res, next) => {
    try {
      void Promise.resolve(handler(req, res, next)).catch(next)
    } catch (error) {
      next(error)
    }
  }
}

/** Send a JSON response with the supplied HTTP status. */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(data))
}

/**
 * A prefix only matches at a path-segment boundary: the path equals it, the
 * prefix already ends in "/", or the next character starts a subpath ("/") or
 * query ("?"). Keeps /api/messages from riding an /api/me rule.
 */
export function prefixMatches(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false
  if (path.length === prefix.length || prefix.endsWith("/")) return true
  return path[prefix.length] === "/" || path[prefix.length] === "?"
}
