import { open } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import {
  createPullRequestScanner,
  type PullRequestScanner,
  type SessionPullRequest,
} from "../../shared/session/prLinks"

interface IndexEntry {
  /** Bytes already folded into the scanner. */
  parsedBytes: number
  scanner: PullRequestScanner
  /** Keeps a multi-byte character whole when it straddles an append boundary. */
  decoder: StringDecoder
}

const cache = new Map<string, IndexEntry>()
const MAX_ENTRIES = 200

/** Read buffer size, so a transcript is never held in memory whole. */
const CHUNK_BYTES = 256 * 1024
/**
 * Ceiling on the bytes one call folds in. A cold cache over a large session
 * pool would otherwise read every transcript at once; instead each poll
 * advances the backlog and the index catches up over a few of them.
 */
const MAX_BYTES_PER_CALL = 4 * 1024 * 1024

function freshEntry(): IndexEntry {
  return { parsedBytes: 0, scanner: createPullRequestScanner(), decoder: new StringDecoder("utf8") }
}

/** Evicts the least recently used file once the cache is full. */
function touch(filePath: string, entry: IndexEntry) {
  cache.delete(filePath)
  cache.set(filePath, entry)
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
}

/**
 * Pull requests opened by a session, folded incrementally so a live transcript
 * costs only its newly appended bytes instead of a full re-read on every poll.
 *
 * A call folds in at most `MAX_BYTES_PER_CALL`; anything beyond that is picked
 * up by the next call, which resumes from the same byte offset.
 */
export async function getSessionPullRequests(
  filePath: string,
  size: number,
): Promise<SessionPullRequest[]> {
  const cached = cache.get(filePath)
  // A file that shrank was rewritten (undo, branch restore) — its old scan state
  // no longer describes the content, so start over.
  const entry = cached && size >= cached.parsedBytes ? cached : freshEntry()

  if (size > entry.parsedBytes) {
    try {
      const handle = await open(filePath, "r")
      try {
        let remaining = Math.min(size - entry.parsedBytes, MAX_BYTES_PER_CALL)
        const buffer = Buffer.allocUnsafe(Math.min(remaining, CHUNK_BYTES))
        while (remaining > 0) {
          const want = Math.min(remaining, buffer.length)
          const { bytesRead } = await handle.read(buffer, 0, want, entry.parsedBytes)
          if (bytesRead <= 0) break
          entry.scanner.scan(entry.decoder.write(buffer.subarray(0, bytesRead)))
          entry.parsedBytes += bytesRead
          remaining -= bytesRead
        }
      } finally {
        await handle.close()
      }
    } catch {
      cache.delete(filePath)
      return []
    }
  }

  touch(filePath, entry)
  return entry.scanner.pullRequests
}

/**
 * Pull requests for a session the index has already folded in completely.
 * Returns null when it has not caught up to `size`.
 *
 * Callers that run once per page view rather than on a poll cannot advance the
 * backlog themselves: a transcript past MAX_BYTES_PER_CALL would report "no
 * pull requests" on every visit, and that is exactly the long-running kind of
 * session most likely to have opened one. Absent beats confidently wrong.
 */
export function getScannedSessionPullRequests(
  filePath: string,
  size: number,
): SessionPullRequest[] | null {
  const entry = cache.get(filePath)
  if (!entry || entry.parsedBytes < size) return null
  touch(filePath, entry)
  return entry.scanner.pullRequests
}

/** Test helper: drops all cached scan state. */
export function resetSessionPrIndex(): void {
  cache.clear()
}
