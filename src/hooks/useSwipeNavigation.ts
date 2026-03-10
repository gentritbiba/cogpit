import { type RefObject, useRef, useEffect } from "react"

interface SwipeNavigationOptions {
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
  /** Minimum swipe distance in px (default: 50) */
  threshold?: number
  /** Whether swipe is enabled (default: true) */
  enabled?: boolean
}

export function useSwipeNavigation<T extends HTMLElement = HTMLElement>({
  onSwipeLeft,
  onSwipeRight,
  threshold = 50,
  enabled = true,
}: SwipeNavigationOptions): RefObject<T | null> {
  const ref = useRef<T>(null)
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  const onSwipeLeftRef = useRef(onSwipeLeft)
  const onSwipeRightRef = useRef(onSwipeRight)
  onSwipeLeftRef.current = onSwipeLeft
  onSwipeRightRef.current = onSwipeRight

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return

    function handleTouchStart(e: TouchEvent) {
      const touch = e.touches[0]
      touchStart.current = { x: touch.clientX, y: touch.clientY }
    }

    function handleTouchEnd(e: TouchEvent) {
      if (!touchStart.current) return
      const touch = e.changedTouches[0]
      const dx = touch.clientX - touchStart.current.x
      const dy = touch.clientY - touchStart.current.y
      touchStart.current = null

      // Only count horizontal swipes (dx > dy)
      if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy)) return

      if (dx > 0) {
        onSwipeRightRef.current?.()
      } else {
        onSwipeLeftRef.current?.()
      }
    }

    el.addEventListener("touchstart", handleTouchStart, { passive: true })
    el.addEventListener("touchend", handleTouchEnd, { passive: true })
    return () => {
      el.removeEventListener("touchstart", handleTouchStart)
      el.removeEventListener("touchend", handleTouchEnd)
    }
  }, [enabled, threshold])

  return ref
}
