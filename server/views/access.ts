import type { IncomingMessage, ServerResponse } from "node:http"
import type { SessionAccessLevel } from "../../shared/contracts/sessionAccess"
import { authorizeHostWide, authorizeSession, markDecided, sendSessionHidden } from "../edition"
import { shareGuestSessionId } from "../share/requestGuest"
import type { ViewRecord } from "./store"

/**
 * A view belongs to the session that made it: the caller reaches it as they
 * would that session, and one no session made as host-wide. A share guest
 * reads only its shared session's views. False after answering; a missing
 * view answers like a hidden one, so ids cannot be probed.
 */
export async function authorizeView(req: IncomingMessage, res: ServerResponse, record: ViewRecord | null, needed: SessionAccessLevel): Promise<boolean> {
  const guest = shareGuestSessionId(req)
  if (!record || (guest !== null && (needed !== "view" || record.sessionId !== guest))) {
    markDecided(req)
    sendSessionHidden(res, null)
    return false
  }
  if (guest !== null) {
    markDecided(req)
    return true
  }
  if (!record.sessionId) return authorizeHostWide(req, res)
  return (await authorizeSession(req, res, { sessionId: record.sessionId, readByServer: true }, needed)) !== null
}

