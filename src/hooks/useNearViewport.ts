import { useRef, useState, useEffect } from "react"

/**
 * Shared IntersectionObserver pool — one observer per rootMargin value.
 * Instead of N individual observers (one per turn), a single shared observer
 * watches all elements and routes intersection changes via a callback map.
 * This eliminates the "thundering herd" problem during resize where N
 * observers would each fire setIsNear independently.
 */
const observerPool = new Map<
  string,
  { observer: IntersectionObserver; callbacks: Map<Element, (v: boolean) => void> }
>()

function getSharedObserver(rootMargin: string) {
  let entry = observerPool.get(rootMargin)
  if (!entry) {
    const callbacks = new Map<Element, (v: boolean) => void>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          callbacks.get(e.target)?.(e.isIntersecting)
        }
      },
      { rootMargin },
    )
    entry = { observer, callbacks }
    observerPool.set(rootMargin, entry)
  }
  return entry
}

/**
 * Tracks whether an element is within the extended viewport zone.
 * Uses a shared IntersectionObserver with configurable rootMargin for efficient,
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

    const { observer, callbacks } = getSharedObserver(rootMargin)
    callbacks.set(el, setIsNear)
    observer.observe(el)

    return () => {
      observer.unobserve(el)
      callbacks.delete(el)
    }
  }, [rootMargin])

  return { ref, isNear }
}
