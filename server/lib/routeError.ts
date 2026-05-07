import type { ServerResponse } from "node:http"

/**
 * Structured error response shape for HTTP routes.
 */
export interface RouteErrorShape {
  error: string
  code: string
  details?: unknown
}

/**
 * Machine-readable error codes for structured route errors.
 */
export const ErrorCodes = {
  NOT_FOUND: "NOT_FOUND",
  INVALID_REQUEST: "INVALID_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  NOT_CONFIGURED: "NOT_CONFIGURED",
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/**
 * Throwable error class that carries an HTTP status + RouteErrorShape.
 */
export class RouteError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = "RouteError"
  }

  toResponse(): RouteErrorShape {
    return {
      error: this.message,
      code: this.code,
      ...(this.details !== undefined ? { details: this.details } : {}),
    }
  }
}

/**
 * Send a standardized error response. Accepts a RouteError directly,
 * or a plain Error (which becomes status 500, code "INTERNAL_ERROR"),
 * or a RouteErrorShape.
 */
export function sendError(
  res: ServerResponse,
  error: RouteError | Error | RouteErrorShape,
  defaultStatus = 500,
): void {
  if (res.writableEnded || res.headersSent) {
    // Response already committed; nothing to send.
    return
  }

  res.setHeader("Content-Type", "application/json")

  if (error instanceof RouteError) {
    res.statusCode = error.status
    res.end(JSON.stringify(error.toResponse()))
    return
  }

  if (error instanceof Error) {
    res.statusCode = defaultStatus
    res.end(
      JSON.stringify({
        error: error.message,
        code: ErrorCodes.INTERNAL_ERROR,
      } satisfies RouteErrorShape),
    )
    return
  }

  // RouteErrorShape
  res.statusCode = defaultStatus
  res.end(JSON.stringify(error))
}
