import type { UseFn } from "../helpers"
import { sendJson } from "../helpers"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { extname } from "node:path"

const IMAGE_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
}

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB

export function registerLocalFileRoutes(use: UseFn) {
  use("/api/local-file", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "", "http://localhost")
    const filePath = url.searchParams.get("path")

    if (!filePath) {
      return sendJson(res, 400, { error: "path query parameter required" })
    }

    if (!filePath.startsWith("/")) {
      return sendJson(res, 400, { error: "path must be absolute" })
    }

    const ext = extname(filePath).toLowerCase()
    const contentType = IMAGE_EXTENSIONS[ext]
    if (!contentType) {
      return sendJson(res, 403, { error: "Only image files are allowed" })
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

    res.statusCode = 200
    res.setHeader("Content-Type", contentType)
    res.setHeader("Cache-Control", "private, max-age=3600")
    createReadStream(filePath).pipe(res)
  })
}
