import type { ParsedSession } from "./types"
import { authFetch } from "./auth"
import { sessionCache } from "./sessionCache"
import { agentKindFromDirName } from "./sessionSource"
import { getActiveDeviceId } from "./device"

interface TailResponse {
  headerLines: string[]
  tailLines: string[]
  byteOffset: number
  totalSize: number
  hasMore: boolean
}

/** Keys currently being fetched — de-duplicates concurrent prefetch calls. */
const inflight = new Set<string>()

// Device-scoped to match sessionCache — a concurrent prefetch for the same
// (dirName, fileName) on a different device must not de-dup against this one.
function makeKey(dirName: string, fileName: string): string {
  return `${getActiveDeviceId()}:${dirName}/${fileName}`
}

/**
 * Warm the session cache for (dirName, fileName) using the `?tail=30` endpoint.
 *
 * Idempotent: returns immediately if the session is already cached or if a
 * prefetch for the same pair is already in flight. Swallows errors — prefetch
 * is best-effort and must never surface failures to the user.
 *
 * Use this from hover-intent handlers on session rows and from idle warm-up
 * after app boot so subsequent switches hit the cache and dispatch the load
 * synchronously.
 */
export async function prefetchSession(
  dirName: string,
  fileName: string,
  workerParse: (text: string) => Promise<ParsedSession>,
): Promise<void> {
  const key = makeKey(dirName, fileName)
  if (inflight.has(key)) return
  if (sessionCache.get(dirName, fileName)) return

  // Snapshot the active device BEFORE the network round-trip. The cache key is
  // device-scoped and computed at set-time; if the user switches devices while
  // this prefetch is in flight, writing now would poison device B's cache with
  // device A's session (or vice-versa).
  const deviceId = getActiveDeviceId()

  inflight.add(key)
  try {
    const res = await authFetch(
      `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}?tail=30`
    )
    if (!res.ok) return
    const data = (await res.json()) as TailResponse

    // Another visit may have populated the cache while we were fetching.
    if (sessionCache.get(dirName, fileName)) return

    const headerSet = new Set(data.headerLines)
    const uniqueTail = data.tailLines.filter((l) => !headerSet.has(l))
    const text = [...data.headerLines, ...uniqueTail].join("\n")
    const parsed = await workerParse(text)

    // Device changed mid-flight — discard rather than cache under the wrong key.
    if (getActiveDeviceId() !== deviceId) return

    sessionCache.set(
      dirName,
      fileName,
      parsed,
      text,
      data.byteOffset,
      data.hasMore,
      agentKindFromDirName(dirName),
      data.totalSize,
    )
  } catch {
    // Best-effort: ignore network or parse failures. The real fetch on click
    // will surface any persistent error to the user.
  } finally {
    inflight.delete(key)
  }
}
