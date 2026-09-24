import type { IncomingMessage } from "node:http"
import type { ListScope } from "../../shared/contracts/sessionAccess"
import { parseScope } from "../edition"

/** The `scope` query parameter of an aggregate request, as far as the caller may use it. */
export function requestScope(req: IncomingMessage): ListScope {
  return parseScope(req, new URL(req.url ?? "/", "http://localhost").searchParams.get("scope"))
}
