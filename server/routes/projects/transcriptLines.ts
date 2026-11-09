/** Lines of a transcript read from a byte window, each with its native byte offset. */
export interface LineRun {
  lines: string[]
  /** `starts[i]` is the native byte offset of `lines[i]`. */
  starts: number[]
  /** Native offset of the window's first complete line, or of the window when it holds none. */
  byteOffset: number
  /** Native offset just past the window's last complete line. */
  end: number
}

const NEWLINE = 0x0a

/** Non-blank lines of `content`, each with its byte offset counted on the raw bytes from `start`. */
export function splitLines(content: Buffer, start: number): { lines: string[]; starts: number[] } {
  const lines: string[] = []
  const starts: number[] = []
  for (let from = 0; from < content.length;) {
    const newline = content.indexOf(NEWLINE, from)
    const end = newline === -1 ? content.length : newline
    const line = content.subarray(from, end).toString("utf-8")
    if (line.trim().length > 0) {
      lines.push(line)
      starts.push(start + from)
    }
    from = end + 1
  }
  return { lines, starts }
}

/**
 * Complete JSONL lines of a byte window starting at `readStart`. When the
 * window begins mid-file its first, possibly partial, line is discarded; when
 * `truncatedEnd` is set its last segment is too unless a newline ends it, so a
 * caller never emits a fragment of a line that runs past the window. Offsets
 * are counted on the raw bytes, so multibyte UTF-8 cannot skew them.
 */
export function extractCompleteLines(buf: Buffer, readStart: number, truncatedEnd: boolean): LineRun {
  const empty: LineRun = { lines: [], starts: [], byteOffset: readStart, end: readStart }
  let contentStart = 0
  if (readStart > 0) {
    const firstNewline = buf.indexOf(NEWLINE)
    if (firstNewline === -1) return empty
    contentStart = firstNewline + 1
  }
  let content = buf.subarray(contentStart)
  if (truncatedEnd) {
    const lastNewline = content.lastIndexOf(NEWLINE)
    if (lastNewline === -1) return empty
    content = content.subarray(0, lastNewline + 1)
  }
  const { lines, starts } = splitLines(content, readStart + contentStart)
  if (lines.length === 0) return empty
  return { lines, starts, byteOffset: readStart + contentStart, end: readStart + contentStart + content.length }
}
