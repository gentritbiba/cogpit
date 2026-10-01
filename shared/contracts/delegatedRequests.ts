import type { PendingInput } from "./pendingInput"

/**
 * A delegated session whose questions go to the user rather than to the agent
 * that started it, with what it is waiting on. Served by `/api/session-requests`.
 */
export interface DelegatedRequest {
  sessionId: string
  /** For opening the session itself, on its device when it has one. */
  address: { dirName: string; fileName: string } | null
  parentSessionId: string | null
  device: { id: string; name: string } | null
  waiting: PendingInput[]
}
