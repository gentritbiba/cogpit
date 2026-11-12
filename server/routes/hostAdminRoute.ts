import type { IncomingMessage, ServerResponse } from "node:http"
import { markDecided, mayActHostWide } from "../edition"
import { sendJson, type UseFn } from "../http"

/**
 * Mount `handler` for GET and POST at exactly `path`, for host administrators
 * only; anyone else is answered 403 with `refusal`.
 */
export function hostAdminRoute(
  use: UseFn,
  path: string,
  refusal: string,
  handler: (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>,
): void {
  use(path, async (req, res, next) => {
    const rest = new URL(req.url || "/", "http://localhost").pathname
    if (rest !== "/" && rest !== "") return next()
    if (req.method !== "GET" && req.method !== "POST") return next()
    markDecided(req)
    if (!mayActHostWide(req)) return sendJson(res, 403, { error: refusal })
    await handler(req, res)
  })
}
