import { open, readFile, stat } from "node:fs/promises"
import { formatForRecords } from "../shared/session/agents"
import { deriveSessionStatus, type SessionStatusInfo } from "../shared/session/sessionStatus"
import type { RawRecord } from "../shared/session/types"
import { storeFor } from "./agents"
import { effortFromRecord, userMessageTextFromLine } from "./agents/recordReaders"
import {
  classifyTailRecord,
  type AgentTailFormat,
  type TailMatch,
} from "./agents/tailRecords"
import { readTranscriptHead } from "./agents/transcriptHead"
import type { SessionMeta } from "./agents/types"

// ── Session metadata extraction ─────────────────────────────────────

/**
 * Metadata for the session at `filePath`. The first record's shape names the
 * agent, and that agent's store reads the rest in whatever way its transcript
 * layout makes cheap.
 */
export async function getSessionMeta(filePath: string): Promise<SessionMeta> {
  const head = await readTranscriptHead(filePath)

  let firstParsed: { type?: unknown } | null = null
  if (head.lines.length > 0) {
    try {
      firstParsed = JSON.parse(head.lines[0]) as { type?: unknown }
    } catch {
      firstParsed = null
    }
  }

  const format = formatForRecords(firstParsed ? [firstParsed] : [])
  return storeFor(format.kind).readSessionMeta(filePath, head)
}

const EFFORT_CHUNK = 65536
const NEWLINE_BYTE = 0x0a

/**
 * Read the effort a session most recently ran at, scanning newest → oldest.
 *
 * Effort changes mid-session, so only the last record reflects current state.
 * Kept out of getSessionMeta because session listings render that for every row
 * and would pay this scan without using the result. Takes a path rather than a
 * session id because findJsonlPath lives in sessionPaths, which imports this
 * module — resolving here would make the cycle.
 */
export async function readTranscriptEffort(filePath: string): Promise<string | null> {
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(filePath)
  } catch {
    return null
  }

  const fh = await open(filePath, "r")
  try {
    let cursor = fileStat.size
    // Held as bytes, not text: a chunk boundary can fall inside a multi-byte
    // character, so only whole lines are ever decoded.
    let leftover = Buffer.alloc(0)

    // No scan cap. An agent that records effort once per turn can push the
    // only effort record megabytes away from the end of a long turn; any
    // fixed budget silently returns null on exactly those sessions.
    while (cursor > 0) {
      const readSize = Math.min(EFFORT_CHUNK, cursor)
      cursor -= readSize
      const buf = Buffer.alloc(readSize)
      const { bytesRead } = await fh.read(buf, 0, readSize, cursor)
      const chunk = Buffer.concat([buf.subarray(0, bytesRead), leftover])

      const firstNewline = chunk.indexOf(NEWLINE_BYTE)
      if (cursor > 0 && firstNewline === -1) {
        // One line longer than a chunk; keep accumulating toward its start.
        leftover = chunk
        continue
      }
      // Below the first newline is a partial line until we reach the head.
      leftover = cursor > 0 ? chunk.subarray(0, firstNewline) : Buffer.alloc(0)

      const body = cursor > 0 ? chunk.subarray(firstNewline + 1) : chunk
      const lines = body.toString("utf-8").split("\n")
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line || (!line.includes("effort") && !line.includes("Effort"))) continue
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (typeof record !== "object" || record === null) continue
        const effort = effortFromRecord(record as Record<string, unknown>)
        if (effort) return effort
      }
    }
  } finally {
    await fh.close()
  }

  return null
}

/**
 * Read backward through a session JSONL to derive agent status.
 *
 * Scans in 4KB chunks from the tail, parsing one line at a time until it finds
 * a record that settles the verdict. This reads only as far as needed —
 * typically one chunk — and hands the result to the same deriveSessionStatus()
 * the client uses.
 *
 * Two phases. Until a turn-ending line is seen the transcript's agent is
 * unknown, so every tail format gets a look at each record; their record
 * vocabularies are disjoint, so at most one answers. A turn-ending line alone
 * cannot tell "done" from "waiting on background agents", so it names the agent
 * and switches the scan into a filtered phase that keeps reading — up to the
 * cap — but only collects lines that could still change that verdict.
 */
export async function getSessionStatus(filePath: string): Promise<SessionStatusInfo> {
  const CHUNK = 4096
  const MAX_CHUNKS = 64 // safety cap: 256KB max scan
  try {
    const fileStat = await stat(filePath)
    if (fileStat.size === 0) return { status: "idle" }

    const fh = await open(filePath, "r")
    try {
      const meaningful: RawRecord[] = []
      let cursor = fileStat.size
      let leftover = ""
      let turnEnded: AgentTailFormat | null = null
      let needUserActivity = false

      /** Cheap string test that keeps the filtered phase from parsing irrelevant lines. */
      const isTailCandidate = (line: string, format: AgentTailFormat): boolean =>
        format.markers.some((marker) => line.includes(marker))
        || (needUserActivity && line.includes('"type":"user"'))

      for (let chunk = 0; chunk < MAX_CHUNKS && cursor > 0; chunk++) {
        const readSize = Math.min(CHUNK, cursor)
        cursor -= readSize
        const buf = Buffer.alloc(readSize)
        const { bytesRead } = await fh.read(buf, 0, readSize, cursor)
        const text = buf.subarray(0, bytesRead).toString("utf-8") + leftover

        // Split into lines, rightmost first
        const lines = text.split("\n")
        // First element may be partial if we didn't hit offset 0
        leftover = cursor > 0 ? lines[0] : ""
        const startIdx = cursor > 0 ? 1 : 0

        for (let i = lines.length - 1; i >= startIdx; i--) {
          const line = lines[i]
          if (!line) continue
          // Filtered phase: skip lines that cannot change the verdict before
          // paying for a JSON parse.
          if (turnEnded && !isTailCandidate(line, turnEnded)) continue

          let record: RawRecord
          try { record = JSON.parse(line) } catch { continue }
          if (typeof record?.type !== "string") continue

          const match: TailMatch | null = turnEnded
            ? { format: turnEnded, verdict: turnEnded.classifyAfterTurnEnd(record) }
            : classifyTailRecord(record)
          if (!match) continue
          const { verdict } = match

          switch (verdict.kind) {
            case "ignore":
              continue
            case "final":
              return verdict.status
            case "keep":
              meaningful.unshift(record)
              if (verdict.sawUserActivity) needUserActivity = false
              continue
            case "answer":
              meaningful.unshift(record)
              return deriveSessionStatus(meaningful)
            case "answer-if-active": {
              meaningful.unshift(record)
              const status = deriveSessionStatus(meaningful)
              if (status.status !== "idle") return status
              continue
            }
            case "turn-end":
              meaningful.unshift(record)
              turnEnded = match.format
              needUserActivity = verdict.awaitUserActivity === true
              continue
          }
        }
      }

      // Exhausted chunks — derive from whatever we collected
      return meaningful.length > 0 ? deriveSessionStatus(meaningful) : { status: "idle" }
    } finally {
      await fh.close()
    }
  } catch {
    return { status: "idle" }
  }
}

/** A short excerpt of `text` around its first occurrence of `query`. */
function snippetAround(text: string, query: string): string {
  const lower = text.toLowerCase()
  const idx = lower.indexOf(query.toLowerCase())
  const start = Math.max(0, idx - 30)
  const end = Math.min(text.length, idx + query.length + 70)
  const snippet = (start > 0 ? "..." : "") + text.slice(start, end).trim() + (end < text.length ? "..." : "")
  return snippet.slice(0, 150)
}

/**
 * Search all user messages in a session file for a query string.
 * Returns the first matching message snippet, or null if no match.
 */
export async function searchSessionMessages(
  filePath: string,
  query: string
): Promise<string | null> {
  const q = query.toLowerCase()

  let content: string
  try {
    content = await readFile(filePath, "utf-8")
  } catch {
    return null
  }

  for (const line of content.split("\n")) {
    const text = userMessageTextFromLine(line)
    if (text !== null && text.toLowerCase().includes(q)) return snippetAround(text, query)
  }

  return null
}
