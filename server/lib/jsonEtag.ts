import { createHash } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"

const opaque = (tag: string) => tag.trim().replace(/^W\//, "")

/** Weak comparison, as `If-None-Match` asks for. */
function clientHas(req: IncomingMessage, etag: string): boolean {
  const header = req.headers["if-none-match"]
  return Boolean(header) && header!.split(",").some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag))
}

/**
 * A JSON 200 with a weak ETag, or a bodiless 304 when `If-None-Match` names
 * it, so a poll that finds nothing new costs the client neither a download
 * nor a parse. `no-cache` makes every poll revalidate.
 */
export function sendJsonWithEtag(req: IncomingMessage, res: ServerResponse, body: unknown): void {
  const json = JSON.stringify(body)
  const etag = `W/"${createHash("sha1").update(json).digest("base64url")}"`
  res.setHeader("ETag", etag)
  res.setHeader("Cache-Control", "no-cache")
  if (clientHas(req, etag)) {
    res.statusCode = 304
    res.end()
    return
  }
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.end(json)
}
