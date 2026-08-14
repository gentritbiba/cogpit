import type { IncomingMessage } from "node:http"
import type { SessionPrincipal } from "./constants"

// Hands the authenticated principal from authMiddleware to route handlers.
// Keyed by the request object itself, the WeakMap retains nothing once the
// request is garbage-collected.
const principals = new WeakMap<IncomingMessage, SessionPrincipal>()

export function setRequestPrincipal(req: IncomingMessage, principal: SessionPrincipal): void {
  principals.set(req, principal)
}

export function getRequestPrincipal(req: IncomingMessage): SessionPrincipal | null {
  return principals.get(req) ?? null
}
