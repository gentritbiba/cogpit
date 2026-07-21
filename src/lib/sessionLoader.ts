/**
 * Unified lazy session loader — the single pipeline every open path uses.
 *
 * Fetches the tail of a session file (`?tail=30`), parses it in the worker,
 * and caches the result in `sessionCache`. Older turns load on demand via
 * `useChunkedSession` (`?before=&count=`), which reads the same cache.
 *
 * Loading the tail instead of the whole file is what makes long sessions open
 * instantly; `watchOffset = totalSize` ensures the live SSE watcher resumes
 * exactly where the tail ended instead of re-streaming the file.
 */

import type { ParsedSession } from "@/lib/types"
import type { SessionSource } from "@/hooks/useLiveSession"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import { agentKindFromDirName } from "@/lib/sessionSource"
import { getActiveDeviceId } from "@/lib/device"

export interface TailResponse {
  headerLines: string[]
  tailLines: string[]
  byteOffset: number
  totalSize: number
  hasMore: boolean
}

export interface LoadedSessionTail {
  parsed: ParsedSession
  source: SessionSource
  byteOffset: number
  hasMore: boolean
}

/** Fetch the tail of a session file and parse it via worker. Uses the ?tail=30 endpoint. */
export async function fetchTailAndParse(
  dirName: string,
  fileName: string,
  workerParse: (text: string) => Promise<ParsedSession>,
  errorLabel: string,
): Promise<LoadedSessionTail> {
  const res = await authFetch(
    `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}?tail=30`
  )
  if (!res.ok) throw new Error(`Failed to load ${errorLabel} (${res.status})`)
  const data: TailResponse = await res.json()

  // Combine header + tail lines, deduplicating overlap for small files
  const headerSet = new Set(data.headerLines)
  const uniqueTail = data.tailLines.filter((l) => !headerSet.has(l))
  const text = [...data.headerLines, ...uniqueTail].join("\n")

  const parsed = await workerParse(text)

  return {
    parsed,
    source: {
      dirName,
      fileName,
      rawText: text,
      agentKind: agentKindFromDirName(dirName),
      watchOffset: data.totalSize,
    },
    byteOffset: data.byteOffset,
    hasMore: data.hasMore,
  }
}

/**
 * Resolve a session via the cache or the tail endpoint and populate the cache.
 * Use this for every open path (dashboard, team, sidebar browser, live list,
 * URL deep-link, branch/duplicate) so switches are always bottom-first and
 * cached — the biggest win for session-switch latency.
 */
export async function loadSessionTailCached(
  dirName: string,
  fileName: string,
  workerParse: (text: string) => Promise<ParsedSession>,
  errorLabel: string,
): Promise<{ parsed: ParsedSession; source: SessionSource }> {
  const cached = sessionCache.get(dirName, fileName)
  if (cached) {
    return { parsed: cached.parsed, source: cached.source }
  }
  const deviceId = getActiveDeviceId()
  const { parsed, source, byteOffset, hasMore } = await fetchTailAndParse(
    dirName,
    fileName,
    workerParse,
    errorLabel,
  )
  // Another load (hover-prefetch vs click) may have populated the cache while
  // we were fetching — and if that session is open and live, the SSE watcher
  // has been advancing the entry's watchOffset. Never clobber a mid-flight
  // entry with our older snapshot; return the existing entry instead.
  const raced = sessionCache.get(dirName, fileName)
  if (raced) {
    return { parsed: raced.parsed, source: raced.source }
  }
  // Only populate the cache if we're still on the same device as when the
  // fetch started (see loadSessionTailFresh for why).
  if (getActiveDeviceId() === deviceId) {
    sessionCache.set(
      dirName,
      fileName,
      parsed,
      source.rawText,
      byteOffset,
      hasMore,
      source.agentKind,
      source.watchOffset,
    )
  }
  return { parsed, source }
}

/**
 * Bypass the cache and tail-fetch fresh, repopulating the cache on success.
 * Use for reload, where the file may have been rewritten (rewind, compaction)
 * and cached turns would be stale.
 */
export async function loadSessionTailFresh(
  dirName: string,
  fileName: string,
  workerParse: (text: string) => Promise<ParsedSession>,
  errorLabel: string,
): Promise<{ parsed: ParsedSession; source: SessionSource }> {
  sessionCache.evict(dirName, fileName)
  // Snapshot the active device BEFORE the network round-trip. The cache key is
  // device-scoped and computed at set-time; if the user switches devices while
  // this tail-load is in flight, caching now would write device B's data under
  // device A's key (or vice-versa).
  const deviceId = getActiveDeviceId()
  const { parsed, source, byteOffset, hasMore } = await fetchTailAndParse(
    dirName,
    fileName,
    workerParse,
    errorLabel,
  )
  // Only populate the cache if we're still on the same device. On a mid-flight
  // switch we skip the write but still return the parsed data so the caller can
  // render what it fetched.
  if (getActiveDeviceId() === deviceId) {
    sessionCache.set(
      dirName,
      fileName,
      parsed,
      source.rawText,
      byteOffset,
      hasMore,
      source.agentKind,
      source.watchOffset,
    )
  }
  return { parsed, source }
}
