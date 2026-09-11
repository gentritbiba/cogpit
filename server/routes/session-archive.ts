import type { IncomingMessage } from "node:http"
import { sendJson } from "../helpers"
import { HttpBodyError, readJsonBody, type UseFn } from "../http"
import { RouteError, sendError, ErrorCodes } from "../lib/routeError"
import { setSessionsArchived } from "../lib/sessionArchive"

const MAX_IDS_PER_REQUEST = 500
const MAX_ID_LENGTH = 512

interface ArchiveRequest {
  sessionIds: string[]
  archived: boolean
}

function parseArchiveRequest(parsed: unknown): ArchiveRequest {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Request body must be a JSON object")
  }
  const { sessionIds, archived } = parsed as Record<string, unknown>
  if (typeof archived !== "boolean") {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "archived must be a boolean")
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0 || sessionIds.length > MAX_IDS_PER_REQUEST) {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, `sessionIds must list 1–${MAX_IDS_PER_REQUEST} sessions`)
  }
  for (const sessionId of sessionIds) {
    // eslint-disable-next-line no-control-regex
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > MAX_ID_LENGTH || /[\x00-\x1f]/.test(sessionId)) {
      throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "sessionIds must be non-empty strings")
    }
  }
  return { sessionIds: [...new Set(sessionIds as string[])], archived }
}

async function readArchiveRequest(req: IncomingMessage): Promise<ArchiveRequest> {
  try {
    return parseArchiveRequest(await readJsonBody(req))
  } catch (error) {
    if (error instanceof HttpBodyError) {
      throw new RouteError(error.statusCode, ErrorCodes.INVALID_REQUEST, error.message)
    }
    throw error
  }
}

/**
 * POST /api/archive-sessions — hide sessions from the sidebar or bring them
 * back. Archiving is a sidebar concern only: transcripts are untouched, and
 * the session list reports `archived` on rows the user chose to hide.
 */
export function registerSessionArchiveRoutes(use: UseFn) {
  use("/api/archive-sessions", async (req, res, next) => {
    if (req.method !== "POST") return next()
    try {
      const request = await readArchiveRequest(req)
      const changed = await setSessionsArchived(request.sessionIds, request.archived)
      sendJson(res, 200, { sessionIds: request.sessionIds, archived: request.archived, changed })
    } catch (err) {
      if (err instanceof RouteError) return sendError(res, err)
      sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, String(err)))
    }
  })
}
