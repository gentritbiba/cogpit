import type { SessionStatus } from "../../../shared/session/sessionStatus"

export function isIdleStatus(status?: SessionStatus): boolean {
  return status === "idle" || status === "completed"
}

/** A session that stopped for a reason, such as a failed sign-in, reads as an error rather than done. */
export function getStatusColor(status?: SessionStatus, terminalReason?: string): string {
  if (terminalReason) return "text-destructive"
  if (isIdleStatus(status)) return "text-success"
  if (status === "thinking" || status === "deferred") return "text-warning"
  return "text-info"
}
