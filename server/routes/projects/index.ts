import type { UseFn } from "../../http"
import {
  getSessionMeta,
  getSessionStatus,
  open,
  readFile,
} from "../../helpers"
import { projectDirNameFor } from "../../../shared/session/agent-descriptors"
import { allStores, storeFor, storeForDirName, storeForPath } from "../../agents"
import { findJsonlPath, resolveSessionFilePath } from "../../sessionPaths"
import { handleActiveSessions } from "./activeSessionsRoute"
import { projectLabel } from "./projectLabel"
import { getOrLoadSessionMeta } from "../../lib/sessionMetaCache"
import { getScannedSessionPullRequests } from "../../lib/sessionPrIndex"
import { parseTailByteBudget, trimTailToByteBudget } from "./tailBudget"

// ── Bottom-first loading helpers ────────────────────────────────────────────

const HEADER_BYTES = 4096
/** Upper bound for growing the header read when the first line is oversized. */
const MAX_HEADER_BYTES = 1024 * 1024

/** Initial byte window per requested turn for `?tail=` and `?before=` pages. */
const PAGE_WINDOW_BYTES_PER_TURN = 65536
/** Every page guarantees at least this many complete lines when available. */
const MIN_PAGE_LINES = 30
/** Hard cap when extending a `?tail=` window to satisfy the min-line floor. */
const MAX_TAIL_WINDOW_BYTES = 2 * 1024 * 1024
/** Hard cap when extending a `?before=` window to satisfy the min-line floor. */
const MAX_BEFORE_WINDOW_BYTES = 4 * 1024 * 1024

interface TailResult {
  lines: string[]
  byteOffset: number
  totalSize: number
}

interface RangeResult {
  lines: string[]
  byteOffset: number
}

interface HeaderResult {
  lines: string[]
  bytesRead: number
}

const NEWLINE = 0x0a

/**
 * Extracts complete JSONL lines from a byte window starting at `readStart`.
 * When the window begins mid-file the first (potentially partial) line is
 * discarded and `byteOffset` advances to the next line boundary — computed on
 * the raw bytes so multibyte UTF-8 content cannot skew offsets. When
 * `truncatedEnd` is set (window ends mid-file without a trailing newline) the
 * final partial segment is discarded as well, so callers never emit a line
 * fragment that overlaps content at or after the window end.
 */
function extractCompleteLines(buf: Buffer, readStart: number, truncatedEnd: boolean): RangeResult {
  let contentStart = 0
  if (readStart > 0) {
    const firstNewline = buf.indexOf(NEWLINE)
    if (firstNewline === -1) return { lines: [], byteOffset: readStart }
    contentStart = firstNewline + 1
  }
  let content = buf.subarray(contentStart)
  if (truncatedEnd) {
    const lastNewline = content.lastIndexOf(NEWLINE)
    if (lastNewline === -1) return { lines: [], byteOffset: readStart }
    content = content.subarray(0, lastNewline + 1)
  }
  const lines = content.toString("utf-8").split("\n").filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { lines: [], byteOffset: readStart }
  return { lines, byteOffset: readStart + contentStart }
}

/**
 * Reads the last `byteCount` bytes of a file and returns complete JSONL lines.
 * When reading from the middle of the file, the first partial line is
 * discarded. If the window yields fewer than `minLines` complete lines it is
 * extended backward (doubling) until satisfied, the start of the file, or
 * `MAX_TAIL_WINDOW_BYTES` — so one fat line cannot reduce the tail to a
 * near-empty page.
 */
async function readTail(filePath: string, byteCount: number, minLines = 0): Promise<TailResult> {
  const fh = await open(filePath, "r")
  try {
    const fileStat = await fh.stat()
    const totalSize = fileStat.size

    let window = Math.min(Math.max(byteCount, 1), totalSize)
    for (;;) {
      const readStart = totalSize - window
      const buf = Buffer.allocUnsafe(window)
      const { bytesRead } = await fh.read(buf, 0, window, readStart)
      const { lines, byteOffset } = extractCompleteLines(buf.subarray(0, bytesRead), readStart, false)

      const canGrow = readStart > 0 && window < MAX_TAIL_WINDOW_BYTES
      if (lines.length >= minLines || !canGrow) {
        return { lines, byteOffset, totalSize }
      }
      window = Math.min(window * 2, MAX_TAIL_WINDOW_BYTES, totalSize)
    }
  } finally {
    await fh.close()
  }
}

/**
 * Reads complete JSONL lines from a byte window ending at `endOffset`
 * (exclusive). Starts with `initialWindow` bytes and extends backward
 * (doubling) until the window yields at least `minLines` complete lines, the
 * start of the file, or `MAX_BEFORE_WINDOW_BYTES`. The returned `byteOffset`
 * is the exact byte position of the first returned line, so paging with
 * `?before=byteOffset` reconstructs the file with no gaps or duplicates.
 */
async function readRangeBefore(
  filePath: string,
  endOffset: number,
  initialWindow: number,
  minLines: number,
): Promise<RangeResult> {
  const fh = await open(filePath, "r")
  try {
    const fileStat = await fh.stat()
    const totalSize = fileStat.size
    const end = Math.min(Math.max(endOffset, 0), totalSize)
    if (end <= 0) return { lines: [], byteOffset: 0 }

    let window = Math.min(Math.max(initialWindow, 1), end)
    for (;;) {
      const readStart = end - window
      const buf = Buffer.allocUnsafe(window)
      const { bytesRead } = await fh.read(buf, 0, window, readStart)
      const view = buf.subarray(0, bytesRead)
      const truncatedEnd = end < totalSize && view[view.length - 1] !== NEWLINE
      const result = extractCompleteLines(view, readStart, truncatedEnd)

      const canGrow = readStart > 0 && window < MAX_BEFORE_WINDOW_BYTES
      if (result.lines.length >= minLines || !canGrow) return result
      window = Math.min(window * 2, MAX_BEFORE_WINDOW_BYTES, end)
    }
  } finally {
    await fh.close()
  }
}

/**
 * Reads the head of a file for metadata extraction. Starts with `HEADER_BYTES`
 * and grows the read (up to `MAX_HEADER_BYTES`) until it contains at least one
 * complete line — newer Codex rollouts embed the full base instructions in the
 * first session_meta line, pushing it well past the initial read size.
 */
export async function readSessionHeader(filePath: string): Promise<HeaderResult> {
  const fh = await open(filePath, "r")
  try {
    const fileStat = await fh.stat()
    let readLen = Math.min(HEADER_BYTES, fileStat.size)
    let text = ""
    let bytesRead = 0
    for (;;) {
      const buf = Buffer.allocUnsafe(readLen)
      const result = await fh.read(buf, 0, readLen, 0)
      bytesRead = result.bytesRead
      text = buf.subarray(0, bytesRead).toString("utf-8")
      const isWholeFile = bytesRead >= fileStat.size
      if (isWholeFile || text.includes("\n") || readLen >= MAX_HEADER_BYTES) break
      readLen = Math.min(readLen * 4, Math.min(fileStat.size, MAX_HEADER_BYTES))
    }
    const parts = text.split("\n").filter((l) => l.trim().length > 0)
    // Drop the last element if we didn't read the whole file — it's likely truncated
    if (bytesRead < fileStat.size && parts.length > 0) {
      parts.pop()
    }
    return { lines: parts, bytesRead }
  } finally {
    await fh.close()
  }
}

export function registerProjectRoutes(use: UseFn) {
  // GET /api/codex-subagents - list Codex sub-agent rollouts across projects
  use("/api/codex-subagents", async (_req, res, next) => {
    if (_req.method !== "GET") return next()

    try {
      const subagents = []
      for (const file of await storeFor("codex").listSessionFiles()) {
        try {
          const meta = await getSessionMeta(file.filePath)
          if (!meta.isSubagent || !meta.parentSessionId || !meta.cwd) continue
          subagents.push({
            ...meta,
            fileName: `${meta.parentSessionId}/subagents/agent-${meta.sessionId}.jsonl`,
            dirName: projectDirNameFor("codex", meta.cwd),
            size: file.size,
            lastModified: new Date(file.mtimeMs).toISOString(),
          })
        } catch { /* ignore incomplete rollouts */ }
      }
      subagents.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(subagents))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  // GET /api/projects - list all projects
  use("/api/projects", async (_req, res, next) => {
    if (_req.method !== "GET") return next()
    if (_req.url && _req.url !== "/" && _req.url !== "") return next()

    try {
      const projects = []
      for (const store of allStores()) {
        for (const project of await store.listProjects()) {
          projects.push({ ...project, shortName: projectLabel(project.dirName, project.path) })
        }
      }

      projects.sort((a, b) => {
        if (!a.lastModified) return 1
        if (!b.lastModified) return -1
        return b.lastModified.localeCompare(a.lastModified)
      })

      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(projects))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })

  // GET /api/sessions/:dirName - list sessions / serve file content
  use("/api/sessions/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)

    if (parts.length === 1) {
      const dirName = decodeURIComponent(parts[0])

      try {
        const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10))
        const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)), 200)

        const files = await storeForDirName(dirName).listProjectSessionFiles(dirName)
        if (!files) {
          res.statusCode = 403
          res.end(JSON.stringify({ error: "Access denied" }))
          return
        }
        const fileStats = files.map((file) => ({
          fileName: file.fileName,
          filePath: file.filePath,
          mtime: new Date(file.mtimeMs),
          size: file.size,
          sessionId: file.sessionId,
        }))

        fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

        const total = fileStats.length
        const start = (page - 1) * limit
        const paged = fileStats.slice(start, start + limit)

        // Same shape as /api/active-sessions, so a row reads the same whether it
        // came from the live list or this listing — and shares that route's meta
        // cache, so a session in both costs one parse between them.
        const sessions = await Promise.all(paged.map(async (file) => {
          const fromFile = {
            fileName: file.fileName,
            sessionId: file.sessionId || file.fileName.replace(".jsonl", ""),
            size: file.size,
            lastModified: file.mtime.toISOString(),
          }
          try {
            const { meta, status } = await getOrLoadSessionMeta(
              file.filePath,
              file.mtime.getTime(),
              async () => {
                const [loaded, derived] = await Promise.all([
                  getSessionMeta(file.filePath),
                  getSessionStatus(file.filePath),
                ])
                return { meta: loaded, status: derived }
              },
            )
            // Read-only: this route serves one page view rather than a poll, so
            // it cannot advance a partial scan. Whatever the live list already
            // folded in comes along free.
            const pullRequests = getScannedSessionPullRequests(file.filePath, file.size)
            const { lastTimestamp, ...rest } = meta
            return {
              ...rest,
              ...fromFile,
              sessionId: file.sessionId || meta.sessionId || fromFile.sessionId,
              lastActivityAt: lastTimestamp || fromFile.lastModified,
              agentStatus: status.status,
              agentToolName: status.toolName,
              agentTerminalReason: status.terminalReason,
              agentPendingAgents: status.pendingAgents,
              ...(pullRequests?.length && { pullRequests }),
            }
          } catch {
            return fromFile
          }
        }))

        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify({ sessions, total, page, pageSize: limit }))
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(err) }))
      }
    } else if (parts.length === 3 && parts[2] === "subagents") {
      // GET /api/sessions/{dirName}/{sessionId}/subagents — list subagent files
      const dirName = decodeURIComponent(parts[0])
      const sessionId = decodeURIComponent(parts[1])
      const listing = await storeForDirName(dirName).listSubagentFiles(dirName, sessionId)
      if (!listing) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify(listing))
    } else if (parts.length >= 2) {
      // Serve session file content (supports nested paths like sessionId/subagents/file.jsonl)
      const dirName = decodeURIComponent(parts[0])
      const fileParts = parts.slice(1).map(decodeURIComponent)
      const fileName = fileParts.join("/")

      if (!fileName.endsWith(".jsonl")) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: "Only .jsonl files" }))
        return
      }

      const filePath = await resolveSessionFilePath(dirName, fileName)
      if (!filePath) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: "Access denied" }))
        return
      }

      const tailParam = url.searchParams.get("tail")
      const beforeParam = url.searchParams.get("before")
      const countParam = url.searchParams.get("count")

      try {
        if (tailParam !== null) {
          // ?tail=N — return last N turns worth of lines plus header lines,
          // trimmed to a byte budget so big sessions stay cheap over tunnels.
          // A min-line floor guarantees real pages even around fat lines.
          const requestedTurns = Math.max(1, Math.min(parseInt(tailParam) || 30, 200))
          const minLines = Math.max(requestedTurns, MIN_PAGE_LINES)
          const bytesToRead = requestedTurns * PAGE_WINDOW_BYTES_PER_TURN
          const byteBudget = parseTailByteBudget(url.searchParams.get("maxBytes"))

          const [header, tail] = await Promise.all([
            readSessionHeader(filePath),
            readTail(filePath, bytesToRead, minLines),
          ])

          const trimmed = trimTailToByteBudget(tail.lines, tail.byteOffset, byteBudget, minLines)
          const hasMore = trimmed.byteOffset > header.bytesRead

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            headerLines: header.lines,
            tailLines: trimmed.lines,
            byteOffset: trimmed.byteOffset,
            totalSize: tail.totalSize,
            hasMore,
          }))
        } else if (beforeParam !== null) {
          // ?before=offset&count=N — return lines before the given byte offset,
          // extending the read window until the page has enough complete lines
          const endOffset = Math.max(0, parseInt(beforeParam) || 0)
          const requestedTurns = Math.max(1, Math.min(parseInt(countParam || "") || 30, 200))
          const minLines = Math.max(requestedTurns, MIN_PAGE_LINES)
          const initialWindow = requestedTurns * PAGE_WINDOW_BYTES_PER_TURN

          const [header, range] = await Promise.all([
            readSessionHeader(filePath),
            readRangeBefore(filePath, endOffset, initialWindow, minLines),
          ])

          res.setHeader("Content-Type", "application/json")
          res.end(JSON.stringify({
            headerLines: header.lines,
            lines: range.lines,
            byteOffset: range.byteOffset,
            hasMore: range.byteOffset > header.bytesRead,
          }))
        } else {
          // Default: return full file as text/plain (original behavior)
          const content = await readFile(filePath, "utf-8")
          res.setHeader("Content-Type", "text/plain")
          res.end(content)
        }
      } catch {
        res.statusCode = 404
        res.end(JSON.stringify({ error: "File not found" }))
      }
    } else {
      next()
    }
  })

  // GET /api/active-sessions - list most recent sessions across all projects
  use("/api/active-sessions", handleActiveSessions)

  // GET /api/find-session/:sessionId - find a session JSONL file by its session ID
  use("/api/find-session/", async (req, res, next) => {
    if (req.method !== "GET") return next()

    const url = new URL(req.url || "/", "http://localhost")
    const parts = url.pathname.split("/").filter(Boolean)
    if (parts.length !== 1) return next()

    const sessionId = decodeURIComponent(parts[0])
    try {
      const filePath = await findJsonlPath(sessionId)
      const address = filePath ? await storeForPath(filePath)?.sessionAddress(filePath) : null
      if (address) {
        res.setHeader("Content-Type", "application/json")
        res.end(JSON.stringify(address))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: "Session not found" }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: String(err) }))
    }
  })
}
