import { useEffect, useRef, useState } from "react"
import { openSessionStream } from "@/lib/sessionStream"

const DEFAULT_STALE_AFTER_MS = 30_000

interface LiveEventStreamOptions {
  /** Called when the server refuses to reopen the stream because the caller cannot see what it watches. */
  onLost?: () => void
  staleAfterMs?: number
}

/**
 * Subscribe to the shared `{type:"init"|"update"}` SSE protocol used by
 * filesystem-backed live indicators of one session's work.
 */
export function useLiveEventStream(
  url: string | null,
  onUpdate: () => void,
  { onLost, staleAfterMs = DEFAULT_STALE_AFTER_MS }: LiveEventStreamOptions = {},
): { isLive: boolean } {
  const [isLive, setIsLive] = useState(false)
  const onUpdateRef = useRef(onUpdate)
  const onLostRef = useRef(onLost)

  useEffect(() => {
    onUpdateRef.current = onUpdate
    onLostRef.current = onLost
  }, [onUpdate, onLost])

  useEffect(() => {
    if (!url) {
      setIsLive(false)
      return
    }

    let active = true
    let staleTimer: ReturnType<typeof setTimeout> | null = null
    const stream = openSessionStream(url, { onLost: () => onLostRef.current?.() })
    const eventSource = stream.source
    setIsLive(false)

    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => {
        if (active) setIsLive(false)
      }, staleAfterMs)
    }

    eventSource.onmessage = (event) => {
      if (!active) return
      try {
        const data = JSON.parse(event.data) as { type?: unknown }
        if (data.type === "init") {
          resetStaleTimer()
        } else if (data.type === "update") {
          setIsLive(true)
          resetStaleTimer()
          onUpdateRef.current()
        }
      } catch {
        // A malformed event must not tear down a healthy subscription.
      }
    }

    eventSource.onerror = () => {
      if (active) setIsLive(false)
    }

    return () => {
      active = false
      stream.close()
      if (staleTimer) clearTimeout(staleTimer)
    }
  }, [url, staleAfterMs])

  return { isLive }
}
