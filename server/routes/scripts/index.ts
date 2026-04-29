import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { UseFn } from "../../helpers"
import { discoverScripts } from "./discovery"

async function validateDir(dir: string): Promise<string | null> {
  try {
    const resolved = resolve(dir)
    const info = await stat(resolved)
    return info.isDirectory() ? resolved : null
  } catch {
    return null
  }
}

function jsonResponse(res: import("node:http").ServerResponse, data: unknown, statusCode = 200): void {
  res.statusCode = statusCode
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(data))
}

export function registerScriptRoutes(use: UseFn) {
  use("/api/scripts", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")

    // Distinguish from sub-routes (connect strips mount path, so req.url is "/?dir=..." or "/run")
    if (url.pathname !== "/") return next()

    const dir = url.searchParams.get("dir")
    if (!dir) {
      return jsonResponse(res, { error: "dir query param required" }, 400)
    }

    validateDir(dir).then((resolved) => {
      if (!resolved) {
        return jsonResponse(res, { error: "Invalid directory" }, 400)
      }
      return discoverScripts(resolved)
        .then((scripts) => jsonResponse(res, scripts))
        .catch((err) => jsonResponse(res, { error: err.message }, 500))
    })
  })
}
