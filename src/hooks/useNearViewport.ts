import { useRef, useState, useEffect } from "react"

/**
 * Tracks whether an element is within the extended viewport zone.
 * Uses IntersectionObserver with configurable rootMargin for efficient,
 * non-blocking detection. Default "100%" means content renders when within
 * 2x viewport distance (100% above + viewport + 100% below).
 *
 * Items outside this zone render a lightweight placeholder instead of
 * heavy content (ReactMarkdown, Shiki, LCS diffs).
 */
export function useNearViewport(rootMargin = "100%") {
  const ref = useRef<HTMLDivElement>(null)
  const [isNear, setIsNear] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => setIsNear(entry.isIntersecting),
      { rootMargin },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin])

  return { ref, isNear }
}
