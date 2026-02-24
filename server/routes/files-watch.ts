import {
  dirs,
  isWithinDir,
  stat,
  open,
  watch,
  resolve,
} from "../helpers"
import type { UseFn } from "../helpers"

export function registerFileWatchRoutes(use: UseFn) {
  // GET /api/task-output?path=<outputFile> - SSE stream of background task output
  use("/api/task-output", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    const outputPath = url.searchParams.get("path")
    if (!outputPath) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: "path query param required" }))
      return
    }

    // Security: only allow reading from /private/tmp/claude-* or /tmp/claude-*
    const resolved = resolve(outputPath)
    if (
      !resolved.startsWith("/private/tmp/claude-") &&
      !resolved.startsWith("/tmp/claude-")
    ) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: "Access denied - only task output files allowed" }))
      return
    }

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })

    let offset = 0
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let watcherReady = false

    // Read existing content first, then watch for changes
    async function readAndSend() {
      try {
        const s = await stat(resolved)
        if (s.size <= offset) return

        const fh = await open(resolved, "r")
        try {
          const buf = Buffer.alloc(s.size - offset)
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
          offset = s.size
          const text = buf.subarray(0, bytesRead).toString("utf-8")
          if (text) {
            res.write(`data: ${JSON.stringify({ type: "output", text })}\n\n`)
          }
        } finally {
          await fh.close()
        }
      } catch {
        // file may not exist yet or be temporarily unavailable
      }
    }

    // Initial read of existing content
    readAndSend().then(() => {
      watcherReady = true
    })

    // Watch for new content (file may not exist yet)
    let watcher: ReturnType<typeof watch> | null = null
    try {
      watcher = watch(resolved, () => {
        if (!watcherReady) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(readAndSend, 100)
      })
      watcher.on("error", () => {}) // prevent uncaught crash when file is removed
    } catch {
      // file doesn't exist yet -- poller below will pick up changes
    }

    // Also poll every 2s in case fs.watch misses events
    const poller = setInterval(readAndSend, 2000)

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n")
    }, 15000)

    req.on("close", () => {
      watcher?.close()
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(poller)
      clearInterval(heartbeat)
    })
  })

  // GET /api/watch/:dirName/:fileName - SSE stream of new JSONL lines
  use("/api/watch/", (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length !== 2) return next()

    const dirName = decodeURIComponent(parts[0])
    const fileName = decodeURIComponent(parts[1])

    if (!fileName.endsWith(".jsonl")) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: "Only .jsonl files" }))
      return
    }

    const filePath = dirs.PROJECTS_DIR + "/" + dirName + "/" + fileName
    if (!isWithinDir(dirs.PROJECTS_DIR, filePath)) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: "Access denied" }))
      return
    }

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })

    let offset = 0
    let throttleTimer: ReturnType<typeof setTimeout> | null = null
    let trailingTimer: ReturnType<typeof setTimeout> | null = null
    let remainder = "" // partial line buffer
    const THROTTLE_MS = 150

    async function flushNewLines() {
      try {
        const s = await stat(filePath)
        if (s.size < offset) {
          // File was truncated (e.g. by undo). Reset to current size.
          offset = s.size
          remainder = ""
          return
        }
        if (s.size <= offset) {
          // No new bytes on disk, but remainder may hold a complete line
          if (remainder) {
            try {
              JSON.parse(remainder)
              const line = remainder
              remainder = ""
              res.write(
                `data: ${JSON.stringify({ type: "lines", lines: [line] })}\n\n`
              )
            } catch {
              // Not valid JSON yet -- still a partial line, keep waiting
            }
          }
          return
        }

        const fh = await open(filePath, "r")
        try {
          const buf = Buffer.alloc(s.size - offset)
          const { bytesRead } = await fh.read(
            buf,
            0,
            buf.length,
            offset
          )
          offset = s.size

          const raw = remainder + buf.subarray(0, bytesRead).toString("utf-8")
          const rawParts = raw.split("\n")

          // Last element may be a partial line (no trailing \n)
          remainder = rawParts.pop() || ""

          const lines = rawParts.filter((l) => l.trim())
          if (lines.length > 0) {
            res.write(
              `data: ${JSON.stringify({ type: "lines", lines })}\n\n`
            )
          }
        } finally {
          await fh.close()
        }
      } catch {
        // file temporarily unavailable during writes
      }
    }

    let watcher: ReturnType<typeof watch> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let closed = false

    function cleanup() {
      closed = true
      watcher?.close()
      watcher = null
      if (throttleTimer) clearTimeout(throttleTimer)
      if (trailingTimer) clearTimeout(trailingTimer)
      if (pollTimer) clearInterval(pollTimer)
      if (heartbeat) clearInterval(heartbeat)
    }

    // Get initial file size, then start watching
    stat(filePath)
      .then((s) => {
        offset = s.size
        const recentlyActive = Date.now() - s.mtimeMs < 30_000
        res.write(`data: ${JSON.stringify({ type: "init", offset, recentlyActive })}\n\n`)
      })
      .catch(() => {
        res.write(
          `data: ${JSON.stringify({ type: "error", message: "File not found" })}\n\n`
        )
        cleanup()
        res.end()
      })

    // Throttle: fire immediately on first change, then at most once per
    // THROTTLE_MS while writes continue. A trailing flush catches the
    // final write after activity stops.
    try {
      watcher = watch(filePath, () => {
        if (closed) return
        if (trailingTimer) clearTimeout(trailingTimer)
        trailingTimer = setTimeout(() => flushNewLines(), THROTTLE_MS)

        if (throttleTimer) return
        flushNewLines()
        throttleTimer = setTimeout(() => {
          throttleTimer = null
        }, THROTTLE_MS)
      })
      watcher.on("error", () => {}) // prevent uncaught crash when file is removed
    } catch {
      // file may not exist yet -- poller below will pick up changes
    }

    // Poll as a fallback for fs.watch
    const POLL_MS = 500
    pollTimer = setInterval(() => {
      if (!closed) flushNewLines()
    }, POLL_MS)

    // Heartbeat to keep connection alive
    heartbeat = setInterval(() => {
      if (!closed) res.write(": heartbeat\n\n")
    }, 15000)

    // Cleanup on disconnect
    req.on("close", cleanup)
  })
}
