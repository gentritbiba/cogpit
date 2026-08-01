/**
 * Permission response calls.
 *
 * Shared by the session permission bar and the Mission Control grid so both
 * answer requests through exactly one code path. The server resolves purely by
 * session id, so a caller does not need the session to be open.
 */

import { authFetch } from "@/lib/auth"

export type PermissionDecision = "allow" | "allow_always" | "deny"

/** Answer one pending request. Resolves true when the server accepted it. */
export async function respondToPermission(
  sessionId: string,
  requestId: string,
  behavior: PermissionDecision,
): Promise<boolean> {
  const res = await authFetch(`/api/permissions/${encodeURIComponent(sessionId)}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, behavior }),
  })
  return res.ok
}

/** Answer every pending request for a session with the same decision. */
export async function respondToAllPermissions(
  sessionId: string,
  behavior: PermissionDecision,
): Promise<boolean> {
  const res = await authFetch(`/api/permissions/${encodeURIComponent(sessionId)}/respond-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ behavior }),
  })
  return res.ok
}
