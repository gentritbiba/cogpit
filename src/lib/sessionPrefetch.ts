import type { ParsedSession } from "./types"
import { authFetch } from "./auth"
import { sessionCache } from "./sessionCache"
import { agentKindFromDirName } from "./sessionSource"

interface TailResponse {
  headerLines: string[]
  tailLines: string[]
  byteOffset: number
  totalSize: number
  hasMore: boolean
}

/** Keys currently being fetched — de-duplicates concurrent prefetch calls. */
const inflight = new Set<string>()

function makeKey(dirName: string, fileName: string): string {
  return `${dirName}/${fileName}`
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

    sessionCache.set(
      dirName,
      fileName,
      parsed,
      text,
      data.byteOffset,
      data.hasMore,
      agentKindFromDirName(dirName),
    )
  } catch {
    // Best-effort: ignore network or parse failures. The real fetch on click
    // will surface any persistent error to the user.
  } finally {
    inflight.delete(key)
  }
}

