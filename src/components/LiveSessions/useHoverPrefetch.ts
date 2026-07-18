import { useEffect, useRef } from "react"

/** Hover dwell before we warm the session cache — long enough to ignore casual mouse passes. */
export const HOVER_PREFETCH_MS = 120

/**
 * Hover-intent prefetch: invokes `prefetch` after the cursor (or focus) dwells
 * on an element for HOVER_PREFETCH_MS. Pass undefined to disable (e.g. for the
 * already-active session). The pending timer is cancelled on hover end and on
 * unmount so casual mouse passes never fire.
 */
export function useHoverPrefetch(prefetch?: () => void) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const onHoverStart = () => {
    if (!prefetch) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(prefetch, HOVER_PREFETCH_MS)
  }
  const onHoverEnd = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  return { onHoverStart, onHoverEnd }
}
