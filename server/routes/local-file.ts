import { sendJson, type UseFn } from "../http"
import { createReadStream } from "node:fs"
import { extname } from "node:path"
import {
  resolveFileRequestPath,
  validateReadableFile,
} from "./readableFileRequest"

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

    const requestedFile = resolveFileRequestPath(req.url)
    if (!requestedFile.ok) {
      return sendJson(res, requestedFile.statusCode, { error: requestedFile.error })
    }

    const ext = extname(requestedFile.filePath).toLowerCase()
    const contentType = IMAGE_EXTENSIONS[ext]
    if (!contentType) {
      return sendJson(res, 403, { error: "Only image files are allowed" })
    }

    const validation = await validateReadableFile(requestedFile.filePath, MAX_FILE_SIZE)
    if (!validation.ok) {
      return sendJson(res, validation.statusCode, { error: validation.error })
    }

    res.statusCode = 200
    res.setHeader("Content-Type", contentType)
    res.setHeader("Cache-Control", "private, max-age=3600")
    const stream = createReadStream(requestedFile.filePath)
    stream.once("error", (error) => {
      if (!res.headersSent) {
        sendJson(res, 404, { error: "File not found" })
      } else {
        res.destroy(error)
      }
    })
    stream.pipe(res)
  })
}
