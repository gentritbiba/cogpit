import type { ServerResponse } from "node:http"
import { open, readFile } from "../../helpers"
import { sendJson } from "../../http"
import { parseTailByteBudget, trimTailToByteBudget } from "./tailBudget"

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
 * complete line — a transcript can open with the agent's full base
 * instructions, pushing its first line well past the initial read size.
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

/**
 * Serve a transcript the way the timeline pages through it: `?tail=N` for the
 * latest turns, `?before=offset&count=N` for the page above an offset, and
 * otherwise the whole file as text.
 */
export async function serveTranscript(res: ServerResponse, filePath: string, params: URLSearchParams): Promise<void> {
  const tailParam = params.get("tail")
  const beforeParam = params.get("before")
  const countParam = params.get("count")

  try {
    if (tailParam !== null) {
      // ?tail=N — return last N turns worth of lines plus header lines,
      // trimmed to a byte budget so big sessions stay cheap over tunnels.
      // A min-line floor guarantees real pages even around fat lines.
      const requestedTurns = Math.max(1, Math.min(parseInt(tailParam) || 30, 200))
      const minLines = Math.max(requestedTurns, MIN_PAGE_LINES)
      const bytesToRead = requestedTurns * PAGE_WINDOW_BYTES_PER_TURN
      const byteBudget = parseTailByteBudget(params.get("maxBytes"))

      const [header, tail] = await Promise.all([
        readSessionHeader(filePath),
        readTail(filePath, bytesToRead, minLines),
      ])

      const trimmed = trimTailToByteBudget(tail.lines, tail.byteOffset, byteBudget, minLines)
      const hasMore = trimmed.byteOffset > header.bytesRead

      sendJson(res, 200, {
        headerLines: header.lines,
        tailLines: trimmed.lines,
        byteOffset: trimmed.byteOffset,
        totalSize: tail.totalSize,
        hasMore,
      })
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

      sendJson(res, 200, {
        headerLines: header.lines,
        lines: range.lines,
        byteOffset: range.byteOffset,
        hasMore: range.byteOffset > header.bytesRead,
      })
    } else {
      // Default: return full file as text/plain (original behavior)
      const content = await readFile(filePath, "utf-8")
      res.setHeader("Content-Type", "text/plain")
      res.end(content)
    }
  } catch {
    sendJson(res, 404, { error: "File not found" })
  }
}
