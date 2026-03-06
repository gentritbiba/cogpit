import type { UseFn } from "../helpers"
import { sendJson } from "../helpers"
import { readFile, stat } from "node:fs/promises"

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2 MB text limit

export function registerFileContentRoutes(use: UseFn) {
  use("/api/file-content", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "", "http://localhost")
    const filePath = url.searchParams.get("path")

    if (!filePath) {
      return sendJson(res, 400, { error: "path query parameter required" })
    }

    if (!filePath.startsWith("/")) {
      return sendJson(res, 400, { error: "path must be absolute" })
    }

    try {
      const info = await stat(filePath)
      if (!info.isFile()) {
        return sendJson(res, 404, { error: "Not a file" })
      }
      if (info.size > MAX_FILE_SIZE) {
        return sendJson(res, 413, { error: "File too large" })
      }
    } catch {
      return sendJson(res, 404, { error: "File not found" })
    }

    try {
      const content = await readFile(filePath, "utf-8")
      res.statusCode = 200
      res.setHeader("Content-Type", "text/plain; charset=utf-8")
      res.setHeader("Cache-Control", "no-cache")
      res.end(content)
    } catch {
      return sendJson(res, 500, { error: "Failed to read file" })
    }
  })
}
