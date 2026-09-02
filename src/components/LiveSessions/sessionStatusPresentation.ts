import type { SessionStatus } from "../../../shared/session/sessionStatus"

export function isIdleStatus(status?: SessionStatus): boolean {
  return status === "idle" || status === "completed"
}

export function getStatusColor(status?: SessionStatus): string {
  if (isIdleStatus(status)) return "text-success"
  if (status === "thinking" || status === "deferred") return "text-warning"
  return "text-info"
}
