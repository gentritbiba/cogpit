import { authFetch, authUrl } from "@/lib/auth"
import { getCurrentUser } from "@/lib/capabilities"
import { announceAccessFrames, isLossRefusal } from "@/lib/sessionAccessEvents"
import { announceConfigFrames } from "@/lib/sessionConfigEvents"

/** A server-sent event stream about one session. */
export interface SessionStream {
  source: EventSource
  close: () => void
}

interface SessionStreamOptions {
  /**
   * Called when the server refuses to reopen the stream because the caller
   * cannot see what it watches. A refusal that names no session announces
   * nothing, so this is how its watcher hears.
   */
  onLost?: () => void
}

/**
 * Open a stream about one session that passes on what the server says about
 * the caller's access to it: the `access` frames it sends while open, and the
 * refusal that stops it reconnecting. Its `session-config` frames pass on too.
 * An EventSource gives up on an error status without saying which, so on a
 * server that enforces session access a stream that gave up asks once more
 * with fetch, whose refusal carries the access headers.
 */
export function openSessionStream(url: string, { onLost }: SessionStreamOptions = {}): SessionStream {
  const source = new EventSource(authUrl(url))
  const stopFrames = announceAccessFrames(source)
  const stopConfigFrames = announceConfigFrames(source)
  const asking = new AbortController()
  source.addEventListener("error", () => {
    if (source.readyState !== EventSource.CLOSED || getCurrentUser().enforcesSessionAccess !== true) return
    void authFetch(url, { signal: asking.signal }).then((res) => {
      if (!asking.signal.aborted && isLossRefusal(res)) onLost?.()
      return res.body?.cancel()
    }, () => undefined)
  })
  return {
    source,
    close: () => {
      asking.abort()
      stopFrames()
      stopConfigFrames()
      source.close()
    },
  }
}
