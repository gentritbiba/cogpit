import type { IncomingMessage, ServerResponse } from "node:http"
import { requestTargetPath, sendJson, type NextFn } from "../http"
import { isTeamEdition } from "./edition"
import { getRequestPrincipal } from "./requestPrincipal"
import { requirementFor } from "./policy"
import { isShareGuestRequest } from "../share/requestGuest"

/**
 * Role enforcement for team edition, mounted immediately after authMiddleware.
 * authMiddleware decides WHO the request is (principal, share guest, or public
 * carve-out); this decides WHAT that principal may reach, per ROUTE_POLICIES.
 * Personal edition passes straight through.
 */
export function teamAuthzMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): void {
  if (!isTeamEdition()) return next()
  const target = requestTargetPath(req.url || "/")
  if (target === null) {
    // A target with no path — protocol-relative, "*", unparseable — is one no
    // rule in the table can be matched against, and authMiddleware has already
    // refused it. Deny rather than wave it through to whatever the router
    // decides the path was.
    sendJson(res, 403, { error: "Admin access required", code: "FORBIDDEN" })
    return
  }
  const path = target.toLowerCase()
  if (!path.startsWith("/api/") && !path.startsWith("/hub/")) return next()
  const requirement = requirementFor(path, (req.method || "GET").toUpperCase())
  if (requirement === "public") return next()
  const principal = getRequestPrincipal(req)
  if (!principal) {
    // A share guest is scoped by the share allowlist, not by this table: it
    // holds no principal to test a role against, and the allowlist already
    // granted it a far narrower surface than any rule here would. Everything
    // else principal-less is either a public path (handled above) or a hole in
    // authMiddleware, so it fails closed.
    if (isShareGuestRequest(req)) return next()
    sendJson(res, 403, { error: "Admin access required", code: "FORBIDDEN" })
    return
  }
  if (requirement === "admin" && principal.role !== "admin") {
    sendJson(res, 403, { error: "Admin access required", code: "FORBIDDEN" })
    return
  }
  next()
}
