import { useEffect } from "react"

/**
 * Run `poll` now and every `intervalMs` while the tab is visible, and again the
 * moment it becomes visible. `isActive` turns false once the poll is replaced
 * or unmounted, so a late answer is dropped. Pass a stable callback; null stops
 * polling.
 */
export function useVisiblePolling(
  poll: ((isActive: () => boolean) => Promise<void>) | null,
  intervalMs: number,
): void {
  useEffect(() => {
    if (!poll) return
    let active = true
    const pollWhenVisible = () => {
      if (document.visibilityState === "visible") void poll(() => active)
    }
    pollWhenVisible()
    const id = setInterval(pollWhenVisible, intervalMs)
    document.addEventListener("visibilitychange", pollWhenVisible)
    return () => {
      active = false
      clearInterval(id)
      document.removeEventListener("visibilitychange", pollWhenVisible)
    }
  }, [poll, intervalMs])
}
