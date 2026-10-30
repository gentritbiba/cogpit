import { descriptorForDirName, formatFor } from "../../shared/session/agents"
import { storeForPath } from "../agents"
import { decodeRef, readResultBody, type ResultBody } from "../agents/resultRefs"
import { authorizeTranscript } from "../edition/transcript"
import { sendJson, type UseFn } from "../http"
import type { ToolResultBodyResponse } from "../../shared/contracts/toolResults"

/** Characters of a text body one response carries; a reader asks again from `start` for the rest. */
const BODY_CHUNK_CHARS = 1024 * 1024
/** An image travels whole, up to this many base64 characters. */
const MAX_IMAGE_CHARS = 32 * 1024 * 1024

/**
 * GET /api/tool-result/{dirName}/{fileName}?ref=<ref>[&start=<chars>] — one
 * elided result body (result projection v1), read back from the native line
 * its reference names, once the transcript at that address — which must be
 * the one the reference was signed for — is authorized again for the caller.
 */
export function registerToolResultRoutes(use: UseFn) {
  use("/api/tool-result/", async (req, res, next) => {
    if (req.method !== "GET") return next()
    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 2) return next()
    const [dirName, fileName] = parts.map(decodeURIComponent) as [string, string]
    const claims = decodeRef(url.searchParams.get("ref") ?? "")
    if (!claims || claims.dirName !== dirName || claims.fileName !== fileName) {
      sendJson(res, 400, { error: "Invalid result reference" })
      return
    }
    const start = Math.max(0, Number.parseInt(url.searchParams.get("start") ?? "0", 10) || 0)
    const transcript = await authorizeTranscript(req, res, { dirName, fileName }, "view")
    if (transcript === null) return
    const kind = descriptorForDirName(dirName).kind
    if (!transcript.filePath || storeForPath(transcript.filePath)?.kind !== kind) {
      sendJson(res, 403, { error: "Access denied" })
      return
    }
    res.setHeader("Cache-Control", "no-store")
    const body = await readResultBody(formatFor(kind), transcript.filePath, claims).catch((): ResultBody => ({ status: "stale" }))
    if (body.status === "stale") {
      sendJson(res, 410, { error: "The transcript changed since this output was listed; reload the session", state: "stale" })
      return
    }
    if (body.status !== "ok" || (body.kind === "image" && body.body.length > MAX_IMAGE_CHARS)) {
      sendJson(res, 413, { error: "This output is too large to show here", state: "too_large" })
      return
    }
    const text = body.kind === "image" ? body.body : body.body.slice(start, start + BODY_CHUNK_CHARS)
    const end = body.kind === "image" ? body.body.length : start + text.length
    sendJson(res, 200, { kind: body.kind, text, start: body.kind === "image" ? 0 : start, end, total: body.body.length } satisfies ToolResultBodyResponse)
  })
}
