import { sendJson, type UseFn } from "../http"
import { createReadStream } from "node:fs"
import { extname } from "node:path"
import {
  resolveFileRequestPath,
  validateReadableFile,
} from "./readableFileRequest"
import { IMAGE_TYPES, VIDEO_TYPES } from "../../shared/mediaTypes"

const MAX_IMAGE_SIZE = 50 * 1024 * 1024 // 50 MB
const MAX_VIDEO_SIZE = 1024 * 1024 * 1024 // 1 GB ceiling; served in ranges

type ByteRange = { start: number; end: number } | "unsatisfiable" | null

/** Parse a single `bytes=start-end` header against the file size. */
function parseRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, startText, endText] = match
  if (startText === "" && endText === "") return null

  if (startText === "") {
    // Suffix range: the last N bytes.
    const suffix = Math.min(Number(endText), size)
    return suffix === 0 ? "unsatisfiable" : { start: size - suffix, end: size - 1 }
  }

  const start = Number(startText)
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1)
  if (start >= size || start > end) return "unsatisfiable"
  return { start, end }
}

export function registerLocalFileRoutes(use: UseFn) {
  use("/api/local-file", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const requestedFile = resolveFileRequestPath(req.url)
    if (!requestedFile.ok) {
      return sendJson(res, requestedFile.statusCode, { error: requestedFile.error })
    }

    const ext = extname(requestedFile.filePath).toLowerCase()
    const contentType = IMAGE_TYPES[ext] ?? VIDEO_TYPES[ext]
    if (!contentType) {
      return sendJson(res, 403, { error: "Only image and video files are allowed" })
    }

    const maxSize = ext in VIDEO_TYPES ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE
    const validation = await validateReadableFile(requestedFile.filePath, maxSize)
    if (!validation.ok) {
      return sendJson(res, validation.statusCode, { error: validation.error })
    }

    const range = parseRange(req.headers.range, validation.size)
    if (range === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${validation.size}`)
      return sendJson(res, 416, { error: "Range not satisfiable" })
    }

    res.setHeader("Content-Type", contentType)
    res.setHeader("Cache-Control", "private, max-age=3600")
    res.setHeader("Accept-Ranges", "bytes")
    if (range) {
      res.statusCode = 206
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${validation.size}`)
      res.setHeader("Content-Length", range.end - range.start + 1)
    } else {
      res.statusCode = 200
      res.setHeader("Content-Length", validation.size)
    }

    const stream = range
      ? createReadStream(requestedFile.filePath, { start: range.start, end: range.end })
      : createReadStream(requestedFile.filePath)
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
