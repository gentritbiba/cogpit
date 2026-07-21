import {
  dirs,
  isCodexDirName,
  isWithinDir,
  resolveSessionFilePath,
  stat,
  open,
  watch,
} from "../helpers"
import { lstat, readdir, realpath, stat as fsStat } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { StringDecoder } from "node:string_decoder"
import type { UseFn } from "../http"
import * as streamBus from "../lib/streamBus"
import { beginActivity, recordActivity } from "../lib/activityMonitor"

const TASK_OUTPUT_BASES = ["/private/tmp", "/tmp"] as const
const TASK_OUTPUT_READ_CHUNK_BYTES = 256 * 1024
const SESSION_READ_CHUNK_BYTES = 256 * 1024
let canonicalTaskOutputBases: Promise<string[]> | null = null

async function getCanonicalTaskOutputBases(): Promise<string[]> {
  canonicalTaskOutputBases ??= Promise.all(
    TASK_OUTPUT_BASES.map(async (base) => {
      try {
        return await realpath(base)
      } catch {
        return resolve(base)
      }
    }),
  ).then((bases) => [...new Set(bases)])
  return canonicalTaskOutputBases
}

async function canonicalizeIncludingMissing(path: string): Promise<string | null> {
  const missingSegments: string[] = []
  let cursor = path

  while (true) {
    let cursorInfo
    try {
      cursorInfo = await lstat(cursor)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") return null
      const parent = dirname(cursor)
      if (parent === cursor) return null
      missingSegments.unshift(basename(cursor))
      cursor = parent
      continue
    }

    let canonicalCursor: string
    try {
      canonicalCursor = await realpath(cursor)
    } catch {
      // A broken symlink has an lstat result but no canonical destination.
      return null
    }

    if (missingSegments.length > 0) {
      try {
        const canonicalInfo = cursorInfo.isSymbolicLink()
          ? await fsStat(canonicalCursor)
          : cursorInfo
        if (!canonicalInfo.isDirectory()) return null
      } catch {
        return null
      }
    }

    return resolve(canonicalCursor, ...missingSegments)
  }
}

function isTaskOutputDescendant(base: string, candidate: string): boolean {
  const child = relative(base, candidate)
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    return false
  }
  const [namespace, ...rest] = child.split(sep)
  return namespace.startsWith("claude-")
    && namespace.length > "claude-".length
    && rest.length > 0
}

/** Resolve a task-output path without allowing symlink escapes from a claude-* temp tree. */
export async function resolveTaskOutputPath(outputPath: string): Promise<string | null> {
  const lexicalPath = resolve(outputPath)
  if (!TASK_OUTPUT_BASES.some((base) => isTaskOutputDescendant(resolve(base), lexicalPath))) {
    return null
  }

  const canonicalPath = await canonicalizeIncludingMissing(lexicalPath)
  if (!canonicalPath) return null
  const bases = await getCanonicalTaskOutputBases()
  return bases.some((base) => isTaskOutputDescendant(base, canonicalPath))
    ? canonicalPath
    : null
}

export function registerFileWatchRoutes(use: UseFn) {
  // GET /api/task-output?path=<outputFile> - SSE stream of background task output
  use("/api/task-output", async (req, res, next) => {
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
    const requestedOutputPath = outputPath

    // Security: only allow canonical descendants of /private/tmp/claude-* or
    // /tmp/claude-*. Revalidate before every read because the output file may
    // not exist yet when the stream is opened.
    const resolved = await resolveTaskOutputPath(requestedOutputPath)
    if (!resolved) {
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
    const endTaskOutputStream = beginActivity("Open task output streams")

    let offset = 0
    let decoder = new StringDecoder("utf8")
    let closed = false
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let watcherReady = false
    let readInFlight: Promise<void> | null = null

    // Serialize reads so fs.watch and the fallback poller cannot emit the same
    // range twice. Drain large output in bounded chunks rather than allocating
    // the full unread file in one Buffer.
    function readAndSend(): Promise<void> {
      if (readInFlight) return readInFlight
      readInFlight = (async () => {
        while (!closed) {
          recordActivity("Task output checks")
          try {
            const currentPath = await resolveTaskOutputPath(requestedOutputPath)
            if (!currentPath) return
            const s = await stat(currentPath)
            if (s.size < offset) {
              offset = 0
              decoder = new StringDecoder("utf8")
            }
            if (s.size <= offset) return

            const bytesToRead = Math.min(s.size - offset, TASK_OUTPUT_READ_CHUNK_BYTES)
            const fh = await open(currentPath, "r")
            try {
              const buf = Buffer.alloc(bytesToRead)
              const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
              if (bytesRead <= 0) return
              offset += bytesRead
              recordActivity("Task output reads", { bytes: bytesRead })
              const text = decoder.write(buf.subarray(0, bytesRead))
              if (text) {
                res.write(`data: ${JSON.stringify({ type: "output", text })}\n\n`)
              }
            } finally {
              await fh.close()
            }
          } catch {
            // file may not exist yet or be temporarily unavailable
            return
          }
        }
      })().finally(() => {
        readInFlight = null
      })
      return readInFlight
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
      closed = true
      endTaskOutputStream()
      watcher?.close()
      if (debounceTimer) clearTimeout(debounceTimer)
      clearInterval(poller)
      clearInterval(heartbeat)
    })
  })

  // GET /api/watch/:dirName/:fileName - SSE stream of new JSONL lines
  use("/api/watch/", async (req, res, next) => {
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

    const filePath = await resolveSessionFilePath(dirName, fileName)
    if (!filePath || (!isCodexDirName(dirName) && !isWithinDir(dirs.PROJECTS_DIR, filePath))) {
      res.statusCode = 403
      res.end(JSON.stringify({ error: "Access denied" }))
      return
    }
    const sessionFilePath = filePath

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    })
    const endLiveSessionStream = beginActivity("Open live session streams")

    const offsetParam = url.searchParams.get("offset")
    const requestedOffset = offsetParam === null ? Number.NaN : Number(offsetParam)
    const hasRequestedOffset = Number.isFinite(requestedOffset) && requestedOffset >= 0
    let offset = hasRequestedOffset ? requestedOffset : 0
    let initialized = false
    let throttleTimer: ReturnType<typeof setTimeout> | null = null
    let trailingTimer: ReturnType<typeof setTimeout> | null = null
    let remainder = "" // partial line buffer
    let decoder = new StringDecoder("utf8")
    let flushInFlight: Promise<void> | null = null
    let flushRequested = false
    let watcher: ReturnType<typeof watch> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let closed = false
    const THROTTLE_MS = 150

    function flushNewLines(): Promise<void> {
      if (!initialized || closed) return Promise.resolve()
      if (flushInFlight) {
        flushRequested = true
        return flushInFlight
      }

      flushInFlight = (async () => {
        while (!closed) {
          recordActivity("Session file checks")
          try {
            const s = await stat(sessionFilePath)
            if (s.size < offset) {
              // File was truncated (e.g. by undo). Reset to current size.
              offset = s.size
              remainder = ""
              decoder = new StringDecoder("utf8")
              return
            }
            if (s.size <= offset) {
              // No new bytes on disk, but remainder may hold a complete line.
              if (remainder) {
                try {
                  JSON.parse(remainder)
                  const line = remainder
                  remainder = ""
                  res.write(
                    `data: ${JSON.stringify({ type: "lines", lines: [line] })}\n\n`,
                  )
                } catch {
                  // Not valid JSON yet -- still a partial line, keep waiting.
                }
              }
              return
            }

            const bytesToRead = Math.min(s.size - offset, SESSION_READ_CHUNK_BYTES)
            const fh = await open(sessionFilePath, "r")
            try {
              const buf = Buffer.alloc(bytesToRead)
              const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
              if (bytesRead <= 0) return
              offset += bytesRead
              recordActivity("Session JSONL reads", { bytes: bytesRead })

              const raw = remainder + decoder.write(buf.subarray(0, bytesRead))
              const rawParts = raw.split("\n")

              // Last element may be a partial line (no trailing \n).
              remainder = rawParts.pop() || ""

              const lines = rawParts.filter((line) => line.trim())
              if (lines.length > 0) {
                res.write(`data: ${JSON.stringify({ type: "lines", lines })}\n\n`)
              }
            } finally {
              await fh.close()
            }
          } catch {
            // File temporarily unavailable during writes.
            return
          }
        }
      })().finally(() => {
        flushInFlight = null
        if (flushRequested && !closed) {
          flushRequested = false
          void flushNewLines()
        }
      })
      return flushInFlight
    }

    // ── Token-level streaming (SDK-driven sessions only) ───────────────
    // The stream bus carries partial-message events published by
    // sdk-session.ts. External sessions never publish, so this is inert
    // for them. Codex sessions have no SDK stream either.
    let unsubscribeStream: (() => void) | null = null
    if (!isCodexDirName(dirName)) {
      const sessionId = fileName.replace(/\.jsonl$/, "")
      const snapshot = streamBus.getSnapshot(sessionId)
      if (snapshot && snapshot.length > 0) {
        res.write(`data: ${JSON.stringify({ type: "stream_snapshot", messages: snapshot })}\n\n`)
      }
      unsubscribeStream = streamBus.subscribe(sessionId, (ev) => {
        if (!closed) {
          const payload = JSON.stringify(ev)
          recordActivity("Token stream batches", { bytes: Buffer.byteLength(payload) })
          res.write(`data: ${payload}\n\n`)
        }
      })
    }

    function cleanup() {
      closed = true
      endLiveSessionStream()
      watcher?.close()
      watcher = null
      unsubscribeStream?.()
      unsubscribeStream = null
      if (throttleTimer) clearTimeout(throttleTimer)
      if (trailingTimer) clearTimeout(trailingTimer)
      if (pollTimer) clearInterval(pollTimer)
      if (heartbeat) clearInterval(heartbeat)
    }

    // Establish the baseline after the client snapshot. When the client sends
    // its snapshot byte offset, replay anything written between that snapshot
    // and this connection. Without this, a line written in that race window
    // is skipped and the UI stays one response behind until the next write.
    stat(sessionFilePath)
      .then((s) => {
        if (!hasRequestedOffset) offset = s.size
        else if (offset > s.size) offset = s.size
        initialized = true
        const recentlyActive = Date.now() - s.mtimeMs < 30_000
        res.write(`data: ${JSON.stringify({ type: "init", offset, recentlyActive })}\n\n`)
        void flushNewLines()
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
    let watcherHealthy = false
    try {
      watcher = watch(sessionFilePath, () => {
        if (closed) return
        recordActivity("Session file events")
        if (trailingTimer) clearTimeout(trailingTimer)
        trailingTimer = setTimeout(() => flushNewLines(), THROTTLE_MS)

        if (throttleTimer) return
        flushNewLines()
        throttleTimer = setTimeout(() => {
          throttleTimer = null
        }, THROTTLE_MS)
      })
      watcher.on("error", () => {}) // prevent uncaught crash when file is removed
      watcherHealthy = true
    } catch {
      // file may not exist yet -- poller below will pick up changes
    }

    // Poll as a fallback for fs.watch. With a healthy watcher the poll is
    // only a safety net for missed FSEvents, so it can be slow; without one
    // it's the primary delivery mechanism and must stay fast.
    const POLL_MS = watcherHealthy ? 2000 : 500
    pollTimer = setInterval(() => {
      if (!closed) flushNewLines()
    }, POLL_MS)

    // ── In-progress compaction detection ──────────────────────────────
    // When Claude Code compacts, it spawns a subagent with an ID like
    // "acompact-<hash>" and writes to <sessionId>/subagents/agent-acompact-*.jsonl.
    // Nothing is written to the parent JSONL until compaction finishes,
    // so we poll the subagents dir and send a synthetic SSE event.
    const sessionDir = sessionFilePath.replace(/\.jsonl$/, "")
    const subagentsDir = sessionDir + "/subagents"
    let compactingSignalSent = false

    const compactionPoller = isCodexDirName(dirName)
      ? null
      : setInterval(async () => {
        if (closed) return
        recordActivity("Compaction checks")
        try {
          const files = await readdir(subagentsDir)
          const compactFile = files.find(
            (f) => f.startsWith("agent-acompact") && f.endsWith(".jsonl")
          )
          if (compactFile) {
            const s = await stat(subagentsDir + "/" + compactFile)
            const recentlyActive = Date.now() - s.mtimeMs < 30_000
            if (recentlyActive && !compactingSignalSent) {
              compactingSignalSent = true
              res.write(`data: ${JSON.stringify({ type: "compacting_in_progress" })}\n\n`)
            } else if (!recentlyActive) {
              compactingSignalSent = false
            }
          } else {
            compactingSignalSent = false
          }
        } catch {
          // subagents dir may not exist — that's fine
        }
      }, 1000)

    // Heartbeat to keep connection alive
    heartbeat = setInterval(() => {
      if (!closed) res.write(": heartbeat\n\n")
    }, 15000)

    // Cleanup on disconnect
    req.on("close", () => {
      cleanup()
      if (compactionPoller) clearInterval(compactionPoller)
    })
  })
}
