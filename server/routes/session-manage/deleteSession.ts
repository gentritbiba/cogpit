import { agentKindForDirName } from "../../../shared/session/agent-descriptors"
import { storeForPath } from "../../agents"
import { runtimeFor } from "../../agents/runtimes"
import { reportSessionEvent, removeSessionAccess } from "../../edition"
import { authorizeTranscript } from "../../edition/transcript"
import { sendJson, type UseFn } from "../../http"
import { ErrorCodes, RouteError, sendError } from "../../lib/routeError"
import { forgetSessions } from "../../lib/sessionArchive"
import { revokeShareTokensForSession } from "../../security"
import { listShares, removeShare } from "../../share/registry"
import { handleJsonBody } from "./jsonBody"

/** Matched on the file too: an agent whose transcripts are dated rollouts does not name the file after the session id. */
function sharedSessionIdsFor(sessionId: string, dirName: string, fileName: string): string[] {
  return listShares()
    .filter((share) => (
      share.sessionId === sessionId
      || (share.dirName === dirName && share.fileName === fileName)
    ))
    .map((share) => share.sessionId)
}

/** POST /api/delete-session — delete one transcript: a session's own, or a sub-agent's filed under it. */
export function registerDeleteSessionRoute(use: UseFn): void {
  use("/api/delete-session", (req, res, next) => {
    if (req.method !== "POST") return next()

    const fail = (error: unknown) => {
      sendError(res, new RouteError(
        400,
        ErrorCodes.INVALID_REQUEST,
        error instanceof Error ? error.message : "Failed to delete session",
      ))
    }

    handleJsonBody<unknown>(req, res, async (body) => {
      try {
        const parsed = body as Record<string, unknown>
        const dirName = parsed.dirName as string
        const fileName = parsed.fileName as string

        if (!dirName || !fileName) {
          sendError(res, new RouteError(400, ErrorCodes.INVALID_REQUEST, "dirName and fileName are required"))
          return
        }

        const transcript = await authorizeTranscript(req, res, { dirName, fileName }, "own")
        if (transcript === null) return
        const { filePath, transcriptSessionId } = transcript
        // Deleted elsewhere already: the caller's row is simply stale.
        if (filePath === null) {
          sendError(res, new RouteError(404, ErrorCodes.NOT_FOUND, "Transcript not found"))
          return
        }
        const agentKind = agentKindForDirName(dirName)
        if (storeForPath(filePath)?.kind !== agentKind) {
          sendError(res, new RouteError(403, ErrorCodes.FORBIDDEN, "Access denied"))
          return
        }

        const runtime = runtimeFor(agentKind)
        // A sub-agent's transcript is no session of its own: the runtime and
        // the sidebar know it only by the id a URL carries for it.
        const sessionId = transcriptSessionId ?? runtime.descriptor.sessionFile.urlId(fileName)
        await runtime.deleteSession(sessionId, filePath)
        forgetSessions([sessionId]).catch(() => {})
        // Deleting a sub-agent's transcript leaves its session, and the session's access, in place.
        if (transcriptSessionId !== null) await removeSessionAccess(transcript.sessionId)
        reportSessionEvent(
          req,
          "session.delete",
          { sessionId: transcript.sessionId, agent: agentKind, dirName },
          transcriptSessionId !== null ? { fileName } : { fileName, subagent: true },
        )

        // A share left behind would hand its guest whatever session next
        // claims this id.
        for (const sharedId of sharedSessionIdsFor(sessionId, dirName, fileName)) {
          await removeShare(sharedId)
          revokeShareTokensForSession(sharedId)
        }

        sendJson(res, 200, { success: true })
      } catch (error) {
        fail(error)
      }
    }, fail)
  })
}
