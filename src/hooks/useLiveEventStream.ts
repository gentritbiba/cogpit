import { useEffect, useRef, useState } from "react"
import { authUrl } from "@/lib/auth"

const DEFAULT_STALE_AFTER_MS = 30_000

/**
 * Subscribe to the shared `{type:"init"|"update"}` SSE protocol used by
 * filesystem-backed live indicators.
 */
export function useLiveEventStream(
  url: string | null,
  onUpdate: () => void,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): { isLive: boolean } {
  const [isLive, setIsLive] = useState(false)
  const onUpdateRef = useRef(onUpdate)

  useEffect(() => {
    onUpdateRef.current = onUpdate
  }, [onUpdate])

  useEffect(() => {
    if (!url) {
      setIsLive(false)
      return
    }

    let active = true
    let staleTimer: ReturnType<typeof setTimeout> | null = null
    const eventSource = new EventSource(authUrl(url))
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
      eventSource.close()
      if (staleTimer) clearTimeout(staleTimer)
    }
  }, [url, staleAfterMs])

  return { isLive }
}
