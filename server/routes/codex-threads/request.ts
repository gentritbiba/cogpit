import type { IncomingMessage, ServerResponse } from "node:http"
import type { SessionAccessLevel } from "../../../shared/contracts/sessionAccess"
import { isRecord } from "../../../shared/objects"
import {
  CodexAppServerError,
  CodexAppServerRpcError,
  type CodexAppServer,
  type JsonObject,
} from "../../agents/codexAppServer"
import { authorizeSession, type ActivitySessionRef } from "../../edition"
import { HttpBodyError, readJsonBody, sendJson } from "../../http"

export type CodexThreadClient = Pick<
  CodexAppServer,
  "getGoal" | "setGoal" | "clearGoal" | "steerTurn" | "interruptTurn"
>

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/** A thread's session once the caller holds `level` on it; null after answering. */
export async function authorizeThread(
  req: IncomingMessage,
  res: ServerResponse,
  threadId: string,
  level: SessionAccessLevel,
): Promise<ActivitySessionRef | null> {
  const session = await authorizeSession(req, res, { sessionId: threadId }, level)
  return session && { sessionId: session.sessionId, agent: "codex" }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function pathParts(url: string | undefined): string[] {
  return new URL(url || "/", "http://localhost").pathname
    .split("/")
    .filter(Boolean)
}

export function parseThreadId(segment: string | undefined, field = "threadId"): string {
  let value: string
  try {
    value = decodeURIComponent(segment ?? "")
  } catch {
    throw new RequestError(400, "INVALID_THREAD_ID", `${field} is invalid`)
  }
  if (!THREAD_ID_PATTERN.test(value)) {
    throw new RequestError(
      400,
      "INVALID_THREAD_ID",
      `${field} must be a valid Codex identifier`,
    )
  }
  return value
}

export async function readJsonObject(
  req: IncomingMessage,
  options: { allowEmpty?: boolean } = {},
): Promise<JsonObject> {
  let parsed: unknown
  try {
    parsed = await readJsonBody(req, options)
  } catch (error) {
    if (error instanceof HttpBodyError) {
      throw new RequestError(
        error.statusCode,
        error.statusCode === 413 ? "REQUEST_BODY_TOO_LARGE" : "INVALID_JSON",
        error.message,
      )
    }
    throw error
  }
  if (!isRecord(parsed)) {
    throw new RequestError(
      400,
      "INVALID_REQUEST",
      "Request body must be a JSON object",
    )
  }
  return parsed
}

export function sendRouteError(res: ServerResponse, error: unknown): void {
  if (error instanceof RequestError) {
    sendJson(res, error.status, { error: error.message, code: error.code })
    return
  }
  if (error instanceof CodexAppServerRpcError) {
    const status =
      error.code === -32602 ? 400 : error.code === -32601 ? 501 : 502
    sendJson(res, status, {
      error: error.message,
      code: "CODEX_RPC_ERROR",
      rpcCode: error.code,
    })
    return
  }
  if (error instanceof CodexAppServerError) {
    const noActiveTurn = error.message.startsWith("No active turn is known")
    sendJson(res, noActiveTurn ? 409 : 503, {
      error: error.message,
      code: noActiveTurn ? "NO_ACTIVE_TURN" : "CODEX_UNAVAILABLE",
    })
    return
  }
  sendJson(res, 500, {
    error: errorMessage(error),
    code: "INTERNAL_ERROR",
  })
}
