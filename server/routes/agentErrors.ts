import type { ServerResponse } from "node:http"
import { AgentRuntimeError } from "../agents/runtimes"
import { sendJson } from "../http"
import { ErrorCodes } from "../lib/routeError"

/**
 * One place where an agent failure becomes an HTTP response.
 *
 * Each runtime raises `AgentRuntimeError` with the status and code its own
 * protocol implies — a decision the CLI cannot represent is a 400, a transport
 * that dropped the request is a 502 — so routes stop carrying a per-agent error
 * ladder. Anything else escaping a runtime is unexpected and becomes a 500.
 */
export function sendAgentError(
  res: ServerResponse,
  error: unknown,
  fallbackMessage: string,
): void {
  if (error instanceof AgentRuntimeError) {
    sendJson(res, error.status, {
      error: error.message,
      code: error.code,
      ...error.details,
    })
    return
  }
  sendJson(res, 500, {
    error: error instanceof Error ? error.message : fallbackMessage,
    code: ErrorCodes.INTERNAL_ERROR,
  })
}
