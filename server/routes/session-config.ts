import { isValidContextWindowTokens } from "../../shared/session/contextWindowSettings"
import type { IncomingMessage, ServerResponse } from "node:http"
import { mayActHostWide, authorizeSession, markDecided } from "../edition"
import { readTranscriptEffort, sendJson } from "../helpers"
import { findJsonlPath } from "../sessionPaths"
import { RouteError, sendError, ErrorCodes } from "../lib/routeError"
import { isStoreFile } from "../lib/sessionConfigDir"
import { readSessionConfig } from "../lib/sessionConfigStore"
import { writeSessionConfig } from "../lib/sessionSettings"
import { HttpBodyError, readJsonBody, type UseFn } from "../http"

// Per-session UI configuration (model, effort, permission mode, MCP selection …)
// stored server-side so every Cogpit client — any browser, device, or hub-proxied
// remote — sees the same session controls state. Keys are the session fileName
// (session-specific) or the project dirName (project-level fallback for new
// sessions). PUT merges shallowly so independent writers (composer settings,
// MCP selection) never clobber each other's fields. A session's config follows
// its access; project defaults are for everyone to read and for whoever may act
// host-wide to change.

// No leading dot (rejects "." / ".."), no path separators.
const KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,255}$/

/** A key that names a config file, and no other store's file beside it. */
export function isValidSessionConfigKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !isStoreFile(`${key}.json`)
}

const SESSION_KEY_SUFFIX = ".jsonl"

/**
 * The session a key holds the config of; null for a project dirName key. The
 * suffix is matched in any case: on a case-insensitive filesystem every
 * spelling names the same file.
 */
function sessionOfKey(key: string): string | null {
  return key.toLowerCase().endsWith(SESSION_KEY_SUFFIX) ? key.slice(0, -SESSION_KEY_SUFFIX.length) : null
}

/**
 * Whether the caller may read, or with `writing` change, a key's config: the
 * session it holds the config of, `project` for a project's defaults, or null
 * after answering.
 */
async function authorizeKey(
  req: IncomingMessage,
  res: ServerResponse,
  key: string,
  writing: boolean,
): Promise<{ sessionId: string } | "project" | null> {
  const sessionId = sessionOfKey(key)
  if (sessionId !== null) return authorizeSession(req, res, { sessionId }, writing ? "interact" : "view")
  if (writing && !mayActHostWide(req)) {
    throw new RouteError(403, ErrorCodes.FORBIDDEN, "Admin access required")
  }
  markDecided(req)
  return "project"
}

/**
 * Fall back to the effort the session last ran at when no client has chosen one.
 *
 * Clients used to seed divergent defaults (web "high", iOS "xhigh") and write
 * them back, so opening a session on one device silently rewrote the other.
 * Resolving the transcript server-side gives every client the same value.
 *
 * A stored effort wins, because it is the only value that can be newer than the
 * transcript: a freshly picked effort has not run a turn yet, so overlaying the
 * recorded one would revert the user's choice on the next hydration. An empty
 * string is not a choice — it means "use the provider default" — so it still
 * takes the transcript value.
 *
 * Skipped under ultracode, which pins effectiveEffort to xhigh — that is what
 * the transcript records, so overlaying it would overwrite the underlying
 * preference the composer restores when ultracode is switched back off.
 */
async function withTranscriptEffort(
  key: string,
  stored: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Keys are session fileNames or project dirNames; only the former have a transcript.
  const sessionId = sessionOfKey(key)
  if (sessionId === null || stored.ultracode === true) return stored
  if (typeof stored.effort === "string" && stored.effort) return stored

  try {
    const filePath = await findJsonlPath(sessionId)
    if (!filePath) return stored
    const effort = await readTranscriptEffort(filePath)
    return effort ? { ...stored, effort } : stored
  } catch {
    // An unreadable transcript must not break loading session config.
    return stored
  }
}

function parsePatch(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Session config must be a JSON object")
  }
  const patch = parsed as Record<string, unknown>
  if (!isValidContextWindowTokens(patch.contextWindowTokens)) {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Context window must be a positive whole number of tokens or null")
  }
  return patch
}

async function readPatch(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return parsePatch(await readJsonBody(req))
  } catch (error) {
    if (error instanceof HttpBodyError) {
      throw new RouteError(error.statusCode, ErrorCodes.INVALID_REQUEST, error.message)
    }
    throw error
  }
}

export function registerSessionConfigRoutes(use: UseFn) {
  use("/api/session-config/", async (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()
    const key = decodeURIComponent(parts[0])

    try {
      if (!isValidSessionConfigKey(key)) {
        throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid session config key")
      }

      if (req.method === "GET") {
        if (!(await authorizeKey(req, res, key, false))) return
        return sendJson(res, 200, await withTranscriptEffort(key, await readSessionConfig(key)))
      }

      if (req.method === "PUT" || req.method === "POST") {
        const patch = await readPatch(req)
        const target = await authorizeKey(req, res, key, true)
        if (target === null) return
        // Shallow merge; a field explicitly set to null is removed.
        return sendJson(res, 200, await writeSessionConfig(req, key, target === "project" ? null : target.sessionId, patch))
      }

      next()
    } catch (err) {
      if (err instanceof RouteError) return sendError(res, err)
      sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, String(err)))
    }
  })
}
