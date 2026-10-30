import {
  stat,
  open,
  watch,
} from "../helpers"
import { descriptorForDirName } from "../../shared/session/agent-descriptors"
import { formatFor } from "../../shared/session/agents"
import { storeForPath } from "../agents"
import { projectLine } from "../agents/resultRefs"
import { sessionAgentsRunning } from "../agents/agentsRunning"
import { runtimeForDirName } from "../agents/runtimes"
import { resolveTaskOutput } from "../agents/taskOutput"
import {
  isCompressedTranscript,
  openTranscript,
  statTranscript,
  uncompressedTranscriptName,
} from "../agents/transcriptFile"
import { authorizeStreamSession, visibilityFor } from "../edition"
import { authorizeTranscript } from "../edition/transcript"
import { StringDecoder } from "node:string_decoder"
import { sendJson, type UseFn } from "../http"
import * as streamBus from "../lib/streamBus"
import { beginActivity, recordActivity } from "../lib/activityMonitor"
import { RESULT_PROJECTION } from "../../shared/contracts/toolResults"

const TASK_OUTPUT_READ_CHUNK_BYTES = 256 * 1024
const SESSION_READ_CHUNK_BYTES = 256 * 1024
/** How often a watched session's agents are checked, and how often their activity is re-announced. */
const AGENTS_CHECK_MS = 5000
const AGENTS_RESEND_MS = 10_000

export function registerFileWatchRoutes(use: UseFn) {
  // GET /api/task-output?path=<outputFile>[&sessionId=<id>] - SSE stream of a
  // background task's output, as the session whose task directory holds it
  use("/api/task-output", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const pathParts = url.pathname.split("/").filter(Boolean)
    if (pathParts.length > 0) return next()

    const requestedOutputPath = url.searchParams.get("path")
    if (!requestedOutputPath) {
      sendJson(res, 400, { error: "path query param required" })
      return
    }
    const requestedSessionId = url.searchParams.get("sessionId")
    // A reader that keeps only the last `tail` bytes asks for no more than those.
    const tailParam = Number.parseInt(url.searchParams.get("tail") ?? "", 10)
    const tailBytes = Number.isSafeInteger(tailParam) && tailParam > 0 ? tailParam : null
    const output = await resolveTaskOutput(requestedOutputPath)
    if (!output) {
      sendJson(res, 403, { error: "Access denied - only task output files allowed" })
      return
    }
    if (requestedSessionId !== null && requestedSessionId.toLowerCase() !== output.sessionId) {
      sendJson(res, 403, { error: "Access denied - the output belongs to another session" })
      return
    }
    if (output.sessionId !== null) {
      if (await authorizeStreamSession(req, res, { sessionId: output.sessionId }) === null) return
    } else if (!visibilityFor(req).everything) {
      // Output filed under no session is the host's, for a caller who sees every session.
      sendJson(res, 403, { error: "Access denied" })
      return
    }
    // Session revocation may destroy the response while authorization is in
    // flight. Do not resurrect a closed request by installing SSE resources.
    if (res.destroyed || res.writableEnded) return

    // Revalidated before every read, because the output file may not exist yet
    // when the stream opens.
    const resolveOutput = async () => {
      const current = await resolveTaskOutput(requestedOutputPath)
      return current !== null && current.sessionId === output.sessionId ? current.path : null
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
    let tailPending = tailBytes !== null
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
            const currentPath = await resolveOutput()
            if (!currentPath) return
            const s = await stat(currentPath)
            if (s.size < offset) {
              offset = 0
              decoder = new StringDecoder("utf8")
            }
            let omittedBytes = 0
            if (tailPending) {
              tailPending = false
              omittedBytes = Math.max(0, s.size - tailBytes!)
              offset = omittedBytes
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
              // A tail that starts inside a character skips its continuation bytes.
              let start = 0
              while (omittedBytes > 0 && start < bytesRead && (buf[start]! & 0xc0) === 0x80) start++
              const text = decoder.write(buf.subarray(start, bytesRead))
              if (text || omittedBytes > 0) {
                res.write(`data: ${JSON.stringify({ type: "output", text, ...(omittedBytes > 0 ? { omittedBytes: omittedBytes + start } : {}) })}\n\n`)
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
      watcher = watch(output.path, () => {
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

    const parts = new URL(req.url || "/", "http://localhost").pathname.split("/").filter(Boolean)

    if (parts.length !== 2) return next()

    const dirName = decodeURIComponent(parts[0])
    const fileName = decodeURIComponent(parts[1])

    if (!fileName.endsWith(".jsonl")) {
      sendJson(res, 400, { error: "Only .jsonl files" })
      return
    }

    const transcript = await authorizeTranscript(req, res, { dirName, fileName }, "view")
    if (transcript === null || res.destroyed || res.writableEnded) return
    const { filePath } = transcript
    if (!filePath || storeForPath(filePath)?.kind !== descriptorForDirName(dirName).kind) {
      sendJson(res, 403, { error: "Access denied" })
      return
    }
    let sessionFilePath = filePath
    const format = formatFor(descriptorForDirName(dirName).kind)
    const { isNoiseLine } = format
    const url = new URL(req.url || "/", "http://localhost")
    const projected = url.searchParams.get("projection") === RESULT_PROJECTION
    /**
     * A `lines` event. Noise lines are not sent, but a client advances its
     * resume offset by the bytes of the lines it receives, so their bytes are.
     * A projected stream sends lighter lines, so it states every native byte
     * the event accounts for as `bytes` instead.
     */
    const writeLines = (rawLines: readonly { line: string; offset: number }[]) => {
      const lines: string[] = []
      let skippedBytes = 0
      let bytes = 0
      for (const { line, offset } of rawLines) {
        if (!line.trim()) continue
        const lineBytes = Buffer.byteLength(line, "utf8") + 1
        bytes += lineBytes
        if (isNoiseLine(line)) skippedBytes += lineBytes
        else lines.push(projected ? projectLine(format, line, { dirName, fileName }, offset) : line)
      }
      if (lines.length === 0 && skippedBytes === 0) return
      const event = projected ? { type: "lines", lines, bytes } : { type: "lines", lines, ...(skippedBytes > 0 ? { skippedBytes } : {}) }
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }

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
    // Native byte offset where `remainder` starts, for projected lines' references.
    let lineStart = offset
    let decoder = new StringDecoder("utf8")
    let flushInFlight: Promise<void> | null = null
    let flushRequested = false
    let watcher: ReturnType<typeof watch> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let agentsPoller: ReturnType<typeof setInterval> | null = null
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
            const s = await statTranscript(sessionFilePath)
            if (s.size < offset) {
              // File was truncated (e.g. by undo). Reset to current size.
              offset = s.size
              lineStart = offset
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
                  writeLines([{ line, offset: lineStart }])
                  // Its newline, still to come, arrives as an empty line.
                  lineStart += Buffer.byteLength(line, "utf8")
                } catch {
                  // Not valid JSON yet -- still a partial line, keep waiting.
                }
              }
              return
            }

            const bytesToRead = Math.min(s.size - offset, SESSION_READ_CHUNK_BYTES)
            const fh = await openTranscript(sessionFilePath)
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

              const located = rawParts.map((line) => {
                const at = lineStart
                lineStart += Buffer.byteLength(line, "utf8") + 1
                return { line, offset: at }
              })
              writeLines(located)
            } finally {
              await fh.close()
            }
          } catch {
            if (await followMaterializedTranscript()) continue
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

    // ── Token-level streaming ──────────────────────────────────────────
    // The stream bus carries partial messages from the runtimes that publish
    // them under the session id, which a rollout name buries behind a timestamp
    // and date directories. External/fallback sessions never publish, so
    // subscribing is inert for them and they continue to rely on JSONL file
    // updates. A transcript filed under its session keeps its file stem, which
    // nothing publishes under.
    const sessionId = transcript.transcriptSessionId ?? fileName.replace(/\.jsonl$/, "")
    const descriptor = descriptorForDirName(dirName)
    // An agent that publishes no tokens gives the client nothing to keep a
    // turn "live" by, so its runtime's own turn state is reported instead.
    const runtimeTurnActive = () =>
      !descriptor.capabilities.tokenStreaming
      && runtimeForDirName(dirName).activity(sessionId).running
    const sendCompacting = (active: boolean) => {
      res.write(`data: ${JSON.stringify({ type: "compacting", active })}\n\n`)
    }
    // A compaction is silent for up to minutes, so the heartbeat re-announces
    // it; otherwise the client's stale timer would end the session mid-way.
    const sendHeartbeat = () => {
      if (streamBus.isCompacting(sessionId)) {
        sendCompacting(true)
      } else if (runtimeTurnActive()) {
        res.write(`data: ${JSON.stringify({ type: "runtime_activity" })}\n\n`)
      } else {
        res.write(": heartbeat\n\n")
      }
    }
    // Agents a session started can work long after its turn ends without
    // writing to its transcript, and the client's stale timer would then show
    // the session as finished. While they run this is said again every resend
    // interval, so a dropped connection still lets the client lapse.
    let agentsAnnouncedAt = 0
    let agentsCheckInFlight = false
    const announceRunningAgents = async () => {
      if (closed || agentsCheckInFlight || Date.now() - agentsAnnouncedAt < AGENTS_RESEND_MS) return
      agentsCheckInFlight = true
      recordActivity("Subagent activity checks")
      try {
        if (await sessionAgentsRunning(dirName, sessionId) && !closed) {
          agentsAnnouncedAt = Date.now()
          res.write(`data: ${JSON.stringify({ type: "subagent_activity" })}\n\n`)
        }
      } finally {
        agentsCheckInFlight = false
      }
    }
    if (streamBus.isCompacting(sessionId)) sendCompacting(true)
    // A block is raised once, when the turn is refused, and stays up until the
    // allowance returns — so a client opening the session afterwards has to be
    // told about it here or it would show no reason for the session stopping.
    const rateLimit = streamBus.getRateLimit(sessionId)
    if (rateLimit) {
      res.write(`data: ${JSON.stringify({ type: "rate_limit", block: rateLimit })}\n\n`)
    }
    const snapshot = streamBus.getSnapshot(sessionId)
    if (snapshot && snapshot.length > 0) {
      res.write(`data: ${JSON.stringify({ type: "stream_snapshot", messages: snapshot })}\n\n`)
    }
    let unsubscribeStream: (() => void) | null = streamBus.subscribe(sessionId, (ev) => {
      if (ev.type === "stream_complete") return
      if (!closed) {
        const payload = JSON.stringify(ev)
        recordActivity("Token stream batches", { bytes: Buffer.byteLength(payload) })
        res.write(`data: ${payload}\n\n`)
      }
    })

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
      if (agentsPoller) clearInterval(agentsPoller)
    }

    // Establish the baseline after the client snapshot. When the client sends
    // its snapshot byte offset, replay anything written between that snapshot
    // and this connection. Without this, a line written in that race window
    // is skipped and the UI stays one response behind until the next write.
    statTranscript(sessionFilePath)
      .then((s) => {
        if (!hasRequestedOffset) offset = s.size
        else if (offset > s.size) offset = s.size
        lineStart = offset
        initialized = true
        const recentlyActive = Date.now() - s.mtimeMs < 30_000
        res.write(`data: ${JSON.stringify({ type: "init", offset, recentlyActive })}\n\n`)
        if (runtimeTurnActive()) sendHeartbeat()
        void announceRunningAgents()
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
    function watchSessionFile(): boolean {
      watcher?.close()
      watcher = null
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
        return true
      } catch {
        // file may not exist yet -- poller below will pick up changes
        return false
      }
    }

    /**
     * Resuming a compressed transcript replaces it with its plain form, whose
     * bytes are the decompressed ones, so the stream carries on from `offset`.
     */
    async function followMaterializedTranscript(): Promise<boolean> {
      if (closed || !isCompressedTranscript(sessionFilePath)) return false
      const plainPath = uncompressedTranscriptName(sessionFilePath)
      try {
        await stat(plainPath)
      } catch {
        return false
      }
      sessionFilePath = plainPath
      watchSessionFile()
      return true
    }

    const watcherHealthy = watchSessionFile()

    // Poll as a fallback for fs.watch. With a healthy watcher the poll is
    // only a safety net for missed FSEvents, so it can be slow; without one
    // it's the primary delivery mechanism and must stay fast.
    const POLL_MS = watcherHealthy ? 2000 : 500
    pollTimer = setInterval(() => {
      if (!closed) flushNewLines()
    }, POLL_MS)

    agentsPoller = setInterval(() => void announceRunningAgents(), AGENTS_CHECK_MS)

    // Heartbeat to keep connection alive
    heartbeat = setInterval(() => {
      if (!closed) sendHeartbeat()
    }, 15000)

    // Cleanup on disconnect
    req.on("close", cleanup)
  })
}
