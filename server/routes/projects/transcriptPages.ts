import type { ServerResponse } from "node:http"
import type { AgentFormat } from "../../../shared/session/agents"
import { RESULT_PROJECTION } from "../../../shared/contracts/toolResults"
import { linesBeforeFirstTurn } from "../../../shared/session/pageCuts"
import { projectLine, type TranscriptAddress } from "../../agents/resultRefs"
import { openTranscript, readTranscriptText } from "../../agents/transcriptFile"
import { sendJson } from "../../http"
import { DEFAULT_PAGE_BYTE_BUDGET, DEFAULT_TAIL_BYTE_BUDGET, lineBytes, oldestKeptLine, parseByteBudget } from "./tailBudget"
import { extractCompleteLines, splitLines, type LineRun } from "./transcriptLines"
import { readTurnPage } from "./turnPages"

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
/** Initial window for reading a transcript's last lines on a `?before=` page. */
const LAST_LINES_BYTES = 65536

/** Names the raw lines a transcript's agent writes only for itself. */
type NoiseTest = (line: string) => boolean

type PageFormat = Pick<AgentFormat, "isNoiseLine" | "pageHeaderLine" | "projectResults" | "pageCuts">

const countLines = (lines: readonly string[], isNoise: NoiseTest): number =>
  lines.reduce((count, line) => (isNoise(line) ? count : count + 1), 0)

interface HeaderResult {
  lines: string[]
  starts: number[]
  bytesRead: number
}

/**
 * Reads the last `byteCount` bytes of a file and returns complete JSONL lines.
 * When reading from the middle of the file, the first partial line is
 * discarded. If the window yields fewer than `minLines` complete lines it is
 * extended backward (doubling) until satisfied, the start of the file, or
 * `MAX_TAIL_WINDOW_BYTES` — so one fat line cannot reduce the tail to a
 * near-empty page. Noise lines are returned but not counted.
 */
async function readTail(filePath: string, byteCount: number, minLines: number, isNoise: NoiseTest): Promise<LineRun & { totalSize: number }> {
  const fh = await openTranscript(filePath)
  try {
    const fileStat = await fh.stat()
    const totalSize = fileStat.size

    let window = Math.min(Math.max(byteCount, 1), totalSize)
    for (;;) {
      const readStart = totalSize - window
      const buf = Buffer.allocUnsafe(window)
      const { bytesRead } = await fh.read(buf, 0, window, readStart)
      const run = extractCompleteLines(buf.subarray(0, bytesRead), readStart, false)

      const canGrow = readStart > 0 && window < MAX_TAIL_WINDOW_BYTES
      if (!canGrow || countLines(run.lines, isNoise) >= minLines) {
        return { ...run, totalSize }
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
 * (doubling) until the window yields at least `minLines` complete lines other
 * than noise, the start of the file, or `MAX_BEFORE_WINDOW_BYTES`. A full
 * window with nothing but noise moves on to the bytes before it, so only a
 * page that reaches the start of the file can come back empty. The returned
 * `byteOffset` is the exact byte position of the first line in the window, so
 * paging with `?before=byteOffset` reconstructs the file, less its noise, with
 * no gaps or duplicates. Noise lines are left out of the result.
 */
async function readRangeBefore(
  filePath: string,
  endOffset: number,
  initialWindow: number,
  minLines: number,
  isNoise: NoiseTest,
): Promise<LineRun> {
  const fh = await openTranscript(filePath)
  try {
    const fileStat = await fh.stat()
    const totalSize = fileStat.size
    let end = Math.min(Math.max(endOffset, 0), totalSize)
    if (end <= 0) return { lines: [], starts: [], byteOffset: 0, end: 0 }

    let window = Math.min(Math.max(initialWindow, 1), end)
    for (;;) {
      const readStart = end - window
      const buf = Buffer.allocUnsafe(window)
      const { bytesRead } = await fh.read(buf, 0, window, readStart)
      const view = buf.subarray(0, bytesRead)
      const truncatedEnd = end < totalSize && view[view.length - 1] !== 0x0a
      const run = extractCompleteLines(view, readStart, truncatedEnd)
      const keptAt = run.lines.flatMap((line, index) => (isNoise(line) ? [] : [index]))

      if (readStart > 0 && window < MAX_BEFORE_WINDOW_BYTES && keptAt.length < minLines) {
        window = Math.min(window * 2, MAX_BEFORE_WINDOW_BYTES, end)
      } else if (readStart > 0 && keptAt.length === 0) {
        end = run.byteOffset
        window = Math.min(window, end)
      } else {
        return { ...run, lines: keptAt.map((index) => run.lines[index]), starts: keptAt.map((index) => run.starts[index]) }
      }
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
  const fh = await openTranscript(filePath)
  try {
    const fileStat = await fh.stat()
    let readLen = Math.min(HEADER_BYTES, fileStat.size)
    let buf = Buffer.alloc(0)
    for (;;) {
      buf = Buffer.allocUnsafe(readLen)
      const { bytesRead } = await fh.read(buf, 0, readLen, 0)
      buf = buf.subarray(0, bytesRead)
      const isWholeFile = bytesRead >= fileStat.size
      if (isWholeFile || buf.includes(0x0a) || readLen >= MAX_HEADER_BYTES) break
      readLen = Math.min(readLen * 4, Math.min(fileStat.size, MAX_HEADER_BYTES))
    }
    const { lines, starts } = splitLines(buf, 0)
    // Drop the last element if we didn't read the whole file — it's likely truncated
    if (buf.length < fileStat.size && lines.length > 0) {
      lines.pop()
      starts.pop()
    }
    return { lines, starts, bytesRead: buf.length }
  } finally {
    await fh.close()
  }
}

/**
 * Pages carry the transcript's first line as its format rewrites it for
 * pages: in `headerLines`, and wherever a page itself starts at the top of the
 * file, so readers still recognise it as the header line.
 */
async function firstLineForPages(
  format: PageFormat,
  header: HeaderResult,
  lastLines: () => Promise<readonly string[]>,
): Promise<string | undefined> {
  const first = header.lines[0]
  return first !== undefined && format.pageHeaderLine ? format.pageHeaderLine(first, lastLines) : first
}

/**
 * Serve a transcript the way the timeline pages through it: `?tail=N` for the
 * latest turns, `?before=offset&count=N` for the page above an offset, and
 * otherwise the whole file as text. Pages leave out the format's noise lines;
 * the whole file is sent byte for byte, because its readers count its lines
 * and bytes against the file on disk (undo, the live stream's start offset).
 *
 * With `unit=turns` a page holds whole turns (see `readTurnPage`); without it,
 * pages are cut by lines, as older readers expect.
 */
export async function serveTranscript(
  res: ServerResponse,
  filePath: string,
  params: URLSearchParams,
  format: PageFormat,
  address: TranscriptAddress,
): Promise<void> {
  const isNoise = format.isNoiseLine
  // Opt-in: heavy result bodies stay on the server; offsets and line counts stay native.
  const projected = params.get("projection") === RESULT_PROJECTION
  const tailParam = params.get("tail")
  const beforeParam = params.get("before")
  const countParam = params.get("count")
  const byTurns = params.get("unit") === "turns"

  try {
    if (tailParam === null && beforeParam === null) {
      // Default: return full file as text/plain (original behavior)
      const content = await readTranscriptText(filePath)
      res.setHeader("Content-Type", "text/plain")
      res.end(content)
      return
    }

    const requested = Math.max(1, Math.min(parseInt((tailParam ?? countParam) || "") || 30, 200))
    const minLines = Math.max(requested, MIN_PAGE_LINES)
    const initialWindow = requested * PAGE_WINDOW_BYTES_PER_TURN
    const before = tailParam !== null || beforeParam === null ? null : Math.max(0, parseInt(beforeParam) || 0)
    // A line tail is the end of the file, so its lines also serve the header line's lookup.
    const [header, lineTail] = await Promise.all([
      readSessionHeader(filePath),
      byTurns || before !== null ? undefined : readTail(filePath, initialWindow, minLines, isNoise),
    ])
    const firstLine = await firstLineForPages(format, header, async () =>
      (lineTail ?? await readTail(filePath, LAST_LINES_BYTES, 1, () => false)).lines)
    const sendLine = (line: string, offset: number): string => {
      if (offset === 0 && firstLine !== undefined) return firstLine
      return projected ? projectLine(format, line, address, offset) : line
    }
    const headerLines = header.lines.flatMap((line, index) => (isNoise(line) ? [] : [sendLine(line, header.starts[index])]))

    if (byTurns) {
      const pageHeader = linesBeforeFirstTurn(format, headerLines)
      const page = await readTurnPage(filePath, format, {
        before: before ?? "tail",
        turns: requested,
        budget: parseByteBudget(params.get("maxBytes"), DEFAULT_PAGE_BYTE_BUDGET),
        headerLines: pageHeader,
        send: sendLine,
      })
      const common = { headerLines: pageHeader, byteOffset: page.byteOffset, hasMore: page.hasMore, unit: "turns", cutTurn: page.cutTurn }
      sendJson(res, 200, before === null
        ? { ...common, tailLines: page.lines, totalSize: page.totalSize, end: page.end }
        : { ...common, lines: page.lines })
    } else if (before === null) {
      // ?tail=N — return last N turns worth of lines plus header lines,
      // trimmed to a byte budget so big sessions stay cheap over tunnels.
      // A min-line floor guarantees real pages even around fat lines.
      const tail = lineTail!
      const budget = parseByteBudget(params.get("maxBytes"), DEFAULT_TAIL_BYTE_BUDGET)
      const oldest = oldestKeptLine(tail.lines, budget, minLines, isNoise)
      const byteOffset = oldest < tail.lines.length ? tail.starts[oldest] : tail.end
      sendJson(res, 200, {
        headerLines,
        tailLines: tail.lines.slice(oldest).flatMap((line, index) => (isNoise(line) ? [] : [sendLine(line, tail.starts[oldest + index])])),
        byteOffset,
        totalSize: tail.totalSize,
        hasMore: byteOffset > header.bytesRead,
      })
    } else {
      // ?before=offset&count=N — return lines before the given byte offset,
      // extending the read window until the page has enough complete lines,
      // then keeping the newest that fit the page budget as sent
      const range = await readRangeBefore(filePath, before, initialWindow, minLines, isNoise)
      const sent: string[] = []
      const sentAt = (index: number) => (sent[index] ??= sendLine(range.lines[index], range.starts[index]))
      const budget = parseByteBudget(params.get("maxBytes"), DEFAULT_PAGE_BYTE_BUDGET)
      const oldest = oldestKeptLine(range.lines, budget, minLines, undefined, (_, index) => lineBytes(sentAt(index)))
      const byteOffset = oldest < range.lines.length ? range.starts[oldest] : range.byteOffset
      sendJson(res, 200, {
        headerLines,
        lines: range.lines.slice(oldest).map((_, index) => sentAt(oldest + index)),
        byteOffset,
        hasMore: byteOffset > header.bytesRead,
      })
    }
  } catch {
    sendJson(res, 404, { error: "File not found" })
  }
}
