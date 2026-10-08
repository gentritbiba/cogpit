import type { ServerResponse } from "node:http"
import { AgentRuntimeError } from "../agents/runtimes"
import { DeviceAuthError, DeviceUnreachableError } from "../hub/device-client"
import { DeviceRequestError } from "../hub/deviceRequest"
import { sendJson } from "../http"
import { OrchestrationError } from "../orchestration/store"
import { ErrorCodes, RouteError, sendError } from "../lib/routeError"

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
  if (error instanceof OrchestrationError) {
    sendJson(res, error.status, { error: error.message, code: error.status === 409 ? ErrorCodes.CONFLICT : ErrorCodes.INVALID_REQUEST })
    return
  }
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

/**
 * `sendAgentError` for routes that may answer for a session on a hub device:
 * the device's own refusal keeps its status, and a device that cannot be
 * reached or refuses the hub's credentials is a 502.
 */
export function sendHostError(res: ServerResponse, error: unknown, fallbackMessage: string): void {
  if (error instanceof RouteError) return sendError(res, error)
  if (error instanceof DeviceRequestError) {
    return sendJson(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}) })
  }
  if (error instanceof DeviceUnreachableError || error instanceof DeviceAuthError) {
    return sendJson(res, 502, {
      error: error.message,
      code: error instanceof DeviceAuthError ? "DEVICE_AUTH_FAILED" : "DEVICE_UNREACHABLE",
    })
  }
  sendAgentError(res, error, fallbackMessage)
}
