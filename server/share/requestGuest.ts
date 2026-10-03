import type { IncomingMessage } from "node:http"

/**
 * Marks a request the share branch of authMiddleware admitted, with the one
 * session its share token opens.
 *
 * A guest holds no `SessionPrincipal` and must never be given one: that type
 * is the credential an edition's route policy is written against, and a
 * guest's scope is the share allowlist instead. The edition's authz middleware
 * may refuse anything principal-less it cannot account for, so a guest arrives
 * there labelled rather than merely unlabelled.
 *
 * Keyed by the request object itself, the WeakMap retains nothing once the
 * request is garbage-collected.
 */
const shareGuests = new WeakMap<IncomingMessage, string>()

export function markShareGuestRequest(req: IncomingMessage, sessionId: string): void {
  shareGuests.set(req, sessionId)
}

export function isShareGuestRequest(req: IncomingMessage): boolean {
  return shareGuests.has(req)
}

/** The session a share guest's request is scoped to; null when the request is not a guest's. */
export function shareGuestSessionId(req: IncomingMessage): string | null {
  return shareGuests.get(req) ?? null
}
