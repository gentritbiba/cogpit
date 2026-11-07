import type { AgentFormat } from "../../../shared/session/agents"
import { parsePageRecord } from "../../../shared/session/pageCuts"
import { openTranscript } from "../../agents/transcriptFile"
import { lineBytes } from "./tailBudget"
import { extractCompleteLines, type LineRun } from "./transcriptLines"

/** First backward read; doubled until the page is decided. */
const FIRST_WINDOW_BYTES = 256 * 1024
/** Most a page reads back before it settles for what it found. */
const MAX_WINDOW_BYTES = 64 * 1024 * 1024
/** A turn bigger than this, in bytes sent, is the one a page may cut. */
export const TURN_HARD_CAP_BYTES = 8 * 1024 * 1024

type PageFormat = Pick<AgentFormat, "isNoiseLine" | "pageCuts">

export interface TurnPageRequest {
  /** Native offset the page ends at, exclusive; `"tail"` for the end of the file. */
  before: number | "tail"
  turns: number
  /** Bytes sent the page may hold, unless its one turn is bigger. */
  budget: number
  /** The lines every page is parsed after, as readers prepend them. */
  headerLines: readonly string[]
  /** A line as it is sent, given its native offset. */
  send: (line: string, offset: number) => string
}

export interface TurnPage {
  /** The page's lines as sent, noise left out. */
  lines: string[]
  /** Native offset of the page's first line. */
  byteOffset: number
  /** Native offset just past the page's last complete line. */
  end: number
  totalSize: number
  /** True when the page starts inside a turn too big to send whole. */
  cutTurn: boolean
  /** False once only the header lines are left above the page. */
  hasMore: boolean
}

/**
 * Indexes into `run.lines` at which a page may start. Boundaries come from
 * the format, run over the header and the window as a reader parses them.
 * A window read from mid-file opens on whatever record it lands on, so its
 * first boundary may be one the whole file does not have and is dropped. At
 * the head of the file the first page starts right after the header lines,
 * which no page repeats, and holds whatever precedes the first turn too.
 */
function pageStarts(
  format: PageFormat,
  run: LineRun,
  headerRecords: readonly Record<string, unknown>[],
  isHeaderLine: (line: string, offset: number) => boolean,
  atHead: boolean,
): number[] {
  const records = [...headerRecords]
  const lineOf: number[] = []
  run.lines.forEach((line, index) => {
    if (format.isNoiseLine(line) || isHeaderLine(line, run.starts[index])) return
    const record = parsePageRecord(line)
    if (!record) return
    records.push(record)
    lineOf.push(index)
  })
  // The first cut is either untrusted or, at the head, the first turn's own start.
  const cuts = format.pageCuts(records)
    .slice(1)
    .filter((cut) => cut >= headerRecords.length)
    .map((cut) => lineOf[cut - headerRecords.length])
  if (!atHead) return cuts
  let own = 0
  while (own < run.lines.length && (format.isNoiseLine(run.lines[own]) || isHeaderLine(run.lines[own], run.starts[own]))) own++
  return [own, ...cuts.filter((cut) => cut > own)]
}

/**
 * The page of whole turns that ends at `before`: the newest `turns` turns, or
 * fewer once the next would take it past `budget`, but always at least one.
 * Reads backward in doubling windows until it finds where its oldest turn
 * starts. A turn bigger than `TURN_HARD_CAP_BYTES` (or the budget, when that
 * is bigger) is sent as its newest lines up to that cap, flagged `cutTurn`.
 */
export async function readTurnPage(filePath: string, format: PageFormat, request: TurnPageRequest): Promise<TurnPage> {
  const { turns, budget, send } = request
  const hardCap = Math.max(TURN_HARD_CAP_BYTES, budget)
  const headerLines = new Set(request.headerLines)
  const headerRecords = request.headerLines.map(parsePageRecord).filter((record) => record !== null)
  const sizes = new Map<number, number>()
  const sentLines = new Map<number, string>()
  const sentAt = (line: string, offset: number): string => {
    let sent = sentLines.get(offset)
    if (sent === undefined) {
      sent = send(line, offset)
      sentLines.set(offset, sent)
    }
    return sent
  }
  // Readers leave a page's header lines out of it; the first line is sent rewritten.
  const isHeaderLine = (line: string, offset: number) => headerLines.has(offset === 0 ? sentAt(line, 0) : line)
  const bytesAt = (run: LineRun, index: number): number => {
    const offset = run.starts[index]
    let bytes = sizes.get(offset)
    if (bytes === undefined) {
      bytes = format.isNoiseLine(run.lines[index]) ? 0 : lineBytes(sentAt(run.lines[index], offset))
      sizes.set(offset, bytes)
    }
    return bytes
  }
  /** Bytes of lines `from..to`, counted newest first, stopping once past `limit`. */
  const rangeBytes = (run: LineRun, from: number, to: number, limit: number): number => {
    let total = 0
    for (let index = to - 1; index >= from && total <= limit; index--) total += bytesAt(run, index)
    return total
  }

  const handle = await openTranscript(filePath)
  try {
    const totalSize = (await handle.stat()).size
    const end = request.before === "tail" ? totalSize : Math.min(Math.max(request.before, 0), totalSize)
    /** The page from line `first` of the window; `ownFrom` is where lines past the header begin, when the window holds the head. */
    const page = (run: LineRun, first: number, cutTurn: boolean, ownFrom: number | null): TurnPage => ({
      lines: run.lines.slice(first).flatMap((line, index) =>
        format.isNoiseLine(line) ? [] : [sentAt(line, run.starts[first + index])]),
      byteOffset: first < run.lines.length ? run.starts[first] : run.end,
      end: run.end,
      totalSize,
      cutTurn,
      hasMore: ownFrom === null || first > ownFrom,
    })
    /** The newest lines of the window up to the hard cap: the page of a turn too big to send whole. */
    const cutPage = (run: LineRun, ownFrom: number | null): TurnPage => {
      let first = run.lines.length
      let total = 0
      while (first > (ownFrom ?? 0) && (first === run.lines.length || total + bytesAt(run, first - 1) <= hardCap)) {
        total += bytesAt(run, --first)
      }
      return page(run, first, true, ownFrom)
    }

    let window = Math.min(FIRST_WINDOW_BYTES, end)
    for (;;) {
      const readStart = end - window
      const buffer = Buffer.allocUnsafe(window)
      const { bytesRead } = await handle.read(buffer, 0, window, readStart)
      const run = extractCompleteLines(buffer.subarray(0, bytesRead), readStart, true)
      const atHead = readStart === 0
      const starts = pageStarts(format, run, headerRecords, isHeaderLine, atHead)
      const ownFrom = atHead ? starts[0] : null

      let first = run.lines.length
      let kept = 0
      let keptBytes = 0
      let full = false
      for (let turn = starts.length - 1; turn >= 0; turn--) {
        const turnEnd = turn + 1 < starts.length ? starts[turn + 1] : run.lines.length
        const limit = kept === 0 ? hardCap : budget - keptBytes
        const bytes = rangeBytes(run, starts[turn], turnEnd, limit)
        if (bytes > limit) {
          if (kept === 0) return cutPage(run, ownFrom)
          full = true
          break
        }
        first = starts[turn]
        keptBytes += bytes
        if (++kept === turns) {
          full = true
          break
        }
      }
      if (full || atHead) return page(run, first, false, ownFrom)

      // The lines above the oldest start found belong to a turn whose start
      // is still out of view; stop once they alone rule it out.
      const unplaced = rangeBytes(run, 0, first, kept === 0 ? hardCap : budget - keptBytes)
      if (kept === 0 && unplaced > hardCap) return cutPage(run, null)
      if (kept > 0 && unplaced > budget - keptBytes) return page(run, first, false, null)
      if (window >= MAX_WINDOW_BYTES) return kept > 0 ? page(run, first, false, null) : cutPage(run, null)
      window = Math.min(window * 2, end, MAX_WINDOW_BYTES)
    }
  } finally {
    await handle.close()
  }
}
