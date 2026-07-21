import { sendJson, type UseFn } from "../http"
import { readFile } from "node:fs/promises"
import {
  resolveFileRequestPath,
  validateReadableFile,
} from "./readableFileRequest"

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2 MB text limit

export function registerFileContentRoutes(use: UseFn) {
  use("/api/file-content", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const requestedFile = resolveFileRequestPath(req.url)
    if (!requestedFile.ok) {
      return sendJson(res, requestedFile.statusCode, { error: requestedFile.error })
    }

    const validation = await validateReadableFile(requestedFile.filePath, MAX_FILE_SIZE)
    if (!validation.ok) {
      return sendJson(res, validation.statusCode, { error: validation.error })
    }

    try {
      const content = await readFile(requestedFile.filePath, "utf-8")
      res.statusCode = 200
      res.setHeader("Content-Type", "text/plain; charset=utf-8")
      res.setHeader("Cache-Control", "no-cache")
      res.end(content)
    } catch {
      return sendJson(res, 500, { error: "Failed to read file" })
    }
  })
}
