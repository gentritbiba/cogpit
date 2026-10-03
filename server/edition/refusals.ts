import type { ServerResponse } from "node:http"
import { SESSION_ACCESS_HEADER, SESSION_ID_HEADER, type SessionAccessLevel } from "../../shared/contracts/sessionAccess"
import { sendJson } from "../http"
import { ErrorCodes } from "../lib/routeError"

/**
 * How a session access refusal reads on the wire; the renderer tells the two
 * apart by status and the access header, and learns which session from the
 * id header.
 */

function nameSession(res: ServerResponse, sessionId: string | null): void {
  if (sessionId !== null) res.setHeader(SESSION_ID_HEADER, sessionId)
}

/**
 * No access, or no such session: the caller cannot tell which. `sessionId` is
 * the one the request spelled, never one read from disk, so it says nothing
 * about what exists; null when the request named none.
 */
export function sendSessionHidden(res: ServerResponse, sessionId: string | null): null {
  res.setHeader(SESSION_ACCESS_HEADER, "none")
  nameSession(res, sessionId)
  sendJson(res, 404, { error: "Session not found", code: ErrorCodes.NOT_FOUND })
  return null
}

/** The caller can see the session at `level`, which is too low for the request. */
export function sendSessionDenied(res: ServerResponse, level: SessionAccessLevel, sessionId: string): null {
  res.setHeader(SESSION_ACCESS_HEADER, level)
  nameSession(res, sessionId)
  sendJson(res, 403, { error: "Your access to this session does not allow this", code: ErrorCodes.SESSION_ACCESS_DENIED })
  return null
}
