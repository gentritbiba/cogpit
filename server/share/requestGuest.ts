import type { IncomingMessage } from "node:http"

/**
 * Marks a request the share branch of authMiddleware admitted.
 *
 * A guest holds no team `SessionPrincipal` and must never be given one: that
 * type is the credential every ROUTE_POLICIES rule is written against, and a
 * guest's scope is the share allowlist instead. Team edition's authz middleware
 * refuses anything principal-less it cannot account for, so a guest arrives
 * there labelled rather than merely unlabelled.
 *
 * Keyed by the request object itself, the WeakMap retains nothing once the
 * request is garbage-collected.
 */
const shareGuests = new WeakSet<IncomingMessage>()

export function markShareGuestRequest(req: IncomingMessage): void {
  shareGuests.add(req)
}

export function isShareGuestRequest(req: IncomingMessage): boolean {
  return shareGuests.has(req)
}
