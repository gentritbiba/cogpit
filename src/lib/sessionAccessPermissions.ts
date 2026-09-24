import type { SessionAccessLevel } from "../../shared/contracts/sessionAccess"

/**
 * The caller's access to a session as far as this client knows. "unknown" is
 * a server that enforces session access before a list or the server has said;
 * "none" is the server's definite no. Both leave the session read-only.
 */
export type SessionAccessState = SessionAccessLevel | "unknown" | "none"

/**
 * What the signed-in user may do in one session. Branching and duplicating need
 * only view, which every level has, so they carry no flag.
 */
export interface SessionActionPermissions {
  canInteract: boolean
  canOwn: boolean
  send: boolean
  stop: boolean
  answer: boolean
  configure: boolean
  mcp: boolean
  undo: boolean
  archive: boolean
  delete: boolean
}

function permissions(canInteract: boolean, canOwn: boolean): SessionActionPermissions {
  return Object.freeze({
    canInteract,
    canOwn,
    send: canInteract,
    stop: canInteract,
    answer: canInteract,
    configure: canInteract,
    mcp: canInteract,
    undo: canInteract,
    archive: canOwn,
    delete: canOwn,
  })
}

const READ_ONLY = permissions(false, false)

const BY_STATE: Record<SessionAccessState, SessionActionPermissions> = {
  unknown: READ_ONLY,
  none: READ_ONLY,
  view: READ_ONLY,
  interact: permissions(true, false),
  own: permissions(true, true),
}

export function permissionsForAccess(state: SessionAccessState): SessionActionPermissions {
  return BY_STATE[state]
}
