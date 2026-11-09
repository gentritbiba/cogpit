import { StringDecoder } from "node:string_decoder"
import {
  createPullRequestScanner,
  type PullRequestScanner,
  type SessionPullRequest,
  type SessionPullRequestReference,
} from "../../shared/session/prLinks"
import { isCompressedTranscript, openTranscript, statTranscript } from "../agents/transcriptFile"
import { recencyCache } from "./recencyCache"

interface IndexEntry {
  /** Bytes already folded into the scanner. */
  parsedBytes: number
  scanner: PullRequestScanner
  /** Keeps a multi-byte character whole when it straddles an append boundary. */
  decoder: StringDecoder
}

/**
 * Every sidebar's rows stay cached while it polls them, so a long transcript
 * keeps its scan progress however many users poll other sessions in between.
 */
const cache = recencyCache<IndexEntry>({ capacity: 200, inUseMs: 60_000, ceiling: 5_000 })

/** Read buffer size, so a transcript is never held in memory whole. */
const CHUNK_BYTES = 256 * 1024

export interface SessionPullRequestData {
  pullRequests: SessionPullRequest[]
  references: SessionPullRequestReference[]
}

function freshEntry(): IndexEntry {
  return { parsedBytes: 0, scanner: createPullRequestScanner(), decoder: new StringDecoder("utf8") }
}

/**
 * Pull requests opened by a session, folded incrementally so a live transcript
 * costs only its newly appended bytes instead of a full re-read on every scan.
 * Yields to the event loop between chunks: it runs in the background index.
 */
export async function getCompleteSessionPullRequestData(
  filePath: string,
  size: number,
): Promise<SessionPullRequestData> {
  // Callers pass the listed size, which for a compressed transcript is not
  // the size of the content the scan walks.
  if (isCompressedTranscript(filePath)) {
    try {
      size = (await statTranscript(filePath)).size
    } catch {
      return { pullRequests: [], references: [] }
    }
  }
  const cached = cache.get(filePath)
  // A file that shrank was rewritten (undo, branch restore) — its old scan state
  // no longer describes the content, so start over.
  const entry = cached && size >= cached.parsedBytes ? cached : freshEntry()

  if (size > entry.parsedBytes) {
    try {
      const handle = await openTranscript(filePath)
      try {
        let remaining = size - entry.parsedBytes
        const buffer = Buffer.allocUnsafe(Math.min(remaining, CHUNK_BYTES))
        while (remaining > 0) {
          const want = Math.min(remaining, buffer.length)
          const { bytesRead } = await handle.read(buffer, 0, want, entry.parsedBytes)
          if (bytesRead <= 0) break
          entry.scanner.scan(entry.decoder.write(buffer.subarray(0, bytesRead)))
          entry.parsedBytes += bytesRead
          remaining -= bytesRead
          if (remaining > 0) await new Promise((resolve) => setImmediate(resolve))
        }
      } finally {
        await handle.close()
      }
    } catch {
      cache.delete(filePath)
      return { pullRequests: [], references: [] }
    }
  }

  cache.set(filePath, entry)
  return {
    pullRequests: entry.scanner.pullRequests,
    references: entry.scanner.references,
  }
}

/**
 * Pull requests for a session the index has already folded in completely.
 * Returns null when it has not caught up to `size`.
 *
 * A transcript the background index has not caught up with reports nothing
 * rather than the part it has folded so far: absent beats confidently wrong.
 */
export function getScannedSessionPullRequests(
  filePath: string,
  size: number,
): SessionPullRequest[] | null {
  const entry = cache.get(filePath)
  if (!entry || entry.parsedBytes < size) return completedLookup(filePath, size)
  return entry.scanner.pullRequests
}

type CompletedLookup = (filePath: string, size: number) => SessionPullRequest[] | null
let completedLookup: CompletedLookup = () => null

/** Where results the durable index completed in an earlier run are found, once nothing is scanned in memory. */
export function setCompletedPullRequestLookup(lookup: CompletedLookup): void {
  completedLookup = lookup
}

/** Test helper: drops all cached scan state. */
export function resetSessionPrIndex(): void {
  cache.clear()
}
