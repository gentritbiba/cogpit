import type { IncomingMessage } from "node:http"
import { dirs, join, mkdir, readFile, sendJson } from "../helpers"
import { writeOwnerOnlyJson } from "../atomicJsonFile"
import { RouteError, sendError, ErrorCodes } from "../lib/routeError"
import type { UseFn } from "../http"

// Per-session UI configuration (model, effort, permission mode, MCP selection …)
// stored server-side so every Cogpit client — any browser, device, or hub-proxied
// remote — sees the same session controls state. Keys are the session fileName
// (session-specific) or the project dirName (project-level fallback for new
// sessions). PUT merges shallowly so independent writers (composer settings,
// MCP selection) never clobber each other's fields.

// No leading dot (rejects "." / ".."), no path separators.
const KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,255}$/

export function isValidSessionConfigKey(key: string): boolean {
  return KEY_PATTERN.test(key)
}

function configFilePath(key: string): string {
  return join(dirs.SESSION_CONFIG_DIR, `${key}.json`)
}

async function readStoredConfig(key: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configFilePath(key), "utf-8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Missing or corrupted file — treat as empty config.
  }
  return {}
}

function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString()
      if (body.length > 64 * 1024) {
        reject(new RouteError(413, ErrorCodes.INVALID_REQUEST, "Session config payload too large"))
        req.destroy()
      }
    })
    req.on("end", () => resolve(body))
    req.on("error", reject)
  })
}

function parsePatch(body: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Invalid session config JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RouteError(400, ErrorCodes.INVALID_REQUEST, "Session config must be a JSON object")
  }
  return parsed as Record<string, unknown>
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
        return sendJson(res, 200, await readStoredConfig(key))
      }

      if (req.method === "PUT" || req.method === "POST") {
        const patch = parsePatch(await collectBody(req))
        await mkdir(dirs.SESSION_CONFIG_DIR, { recursive: true })
        // Shallow merge; a field explicitly set to null is removed.
        const merged = { ...(await readStoredConfig(key)), ...patch }
        for (const [field, value] of Object.entries(merged)) {
          if (value === null) delete merged[field]
        }
        await writeOwnerOnlyJson(configFilePath(key), merged)
        return sendJson(res, 200, merged)
      }

      next()
    } catch (err) {
      if (err instanceof RouteError) return sendError(res, err)
      sendError(res, new RouteError(500, ErrorCodes.INTERNAL_ERROR, String(err)))
    }
  })
}
