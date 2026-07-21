import type { ParsedSession } from "./types"
import { sessionCache } from "./sessionCache"
import { loadSessionTailCached } from "./sessionLoader"
import { getActiveDeviceId } from "./device"

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

  inflight.add(key)
  try {
    // loadSessionTailCached owns the device-switch guard and cache population.
    await loadSessionTailCached(dirName, fileName, workerParse, "session prefetch")
  } catch {
    // Best-effort: ignore network or parse failures. The real fetch on click
    // will surface any persistent error to the user.
  } finally {
    inflight.delete(key)
  }
}
