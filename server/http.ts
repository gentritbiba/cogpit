import type { IncomingMessage, ServerResponse } from "node:http"

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
      body += chunk.toString()
    })
    req.on("end", () => {
      if (settled) return
      settled = true
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
