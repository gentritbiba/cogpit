import type { IncomingMessage, ServerResponse } from "node:http"
import { sendJson, type NextFn } from "../http"
import { isTeamEdition } from "./edition"
import { getRequestPrincipal } from "./requestPrincipal"
import { requirementFor } from "./policy"

/**
 * Role enforcement for team edition, mounted immediately after authMiddleware.
 * authMiddleware decides WHO the request is (principal or carve-out); this
 * decides WHAT that principal may reach, per ROUTE_POLICIES. Personal edition
 * passes straight through.
 */
export function teamAuthzMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
): void {
  if (!isTeamEdition()) return next()
  const path = (req.url || "/").split("?")[0].toLowerCase()
  if (!path.startsWith("/api/") && !path.startsWith("/hub/")) return next()
  const requirement = requirementFor(path, (req.method || "GET").toUpperCase())
  if (requirement === "public") return next()
  const principal = getRequestPrincipal(req)
  // Principal-less requests past authMiddleware are its explicit carve-outs
  // (trusted-local /api/notify, first-run /api/team/bootstrap) — admit them.
  if (!principal) return next()
  if (requirement === "admin" && principal.role !== "admin") {
    sendJson(res, 403, { error: "Admin access required", code: "FORBIDDEN" })
    return
  }
  next()
}
