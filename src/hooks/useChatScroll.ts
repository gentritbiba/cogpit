import { useRef, useState, useCallback, useEffect, useMemo } from "react"
import type { ParsedSession } from "@/lib/types"

interface UseChatScrollOpts {
  session: ParsedSession | null
  isLive: boolean
  pendingMessage: string | null
  clearPending: () => void
  sessionChangeKey: number
}

/**
 * Run an action immediately, then twice more across animation frames
 * to ensure it takes effect after React renders and layout settles.
 */
function runAcrossFrames(action: () => void): void {
  action()
  requestAnimationFrame(() => {
    action()
    requestAnimationFrame(action)
  })
}

export function useChatScroll({ session, isLive, pendingMessage, clearPending, sessionChangeKey }: UseChatScrollOpts) {
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const scrollEndRef = useRef<HTMLDivElement>(null)
  const chatIsAtBottomRef = useRef(true)
  const chatScrollOnNextRef = useRef(false)
  const prevTurnCountRef = useRef(0)
  // When set, the next sessionChangeKey scroll will go to top instead of bottom
  const scrollToTopOnNextChangeRef = useRef(false)

  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)

  const smoothScrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      scrollEndRef.current?.scrollIntoView({ behavior: "smooth" })
    })
  }, [])

  const scrollToBottomInstant = useCallback(() => {
    runAcrossFrames(() => {
      const el = chatScrollRef.current
      if (el) el.scrollTop = el.scrollHeight
      chatIsAtBottomRef.current = true
      chatScrollOnNextRef.current = false
    })
  }, [])

  /** Request that the next session load scrolls to top instead of bottom */
  const requestScrollToTop = useCallback(() => {
    scrollToTopOnNextChangeRef.current = true
  }, [])

  // Avoid triggering rerenders when scroll indicators haven't actually changed
  const canScrollUpRef = useRef(false)
  const canScrollDownRef = useRef(false)

  const updateScrollIndicators = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    const up = el.scrollTop > 10
    const down = el.scrollHeight - el.scrollTop - el.clientHeight > 10
    if (up !== canScrollUpRef.current) {
      canScrollUpRef.current = up
      setCanScrollUp(up)
    }
    if (down !== canScrollDownRef.current) {
      canScrollDownRef.current = down
      setCanScrollDown(down)
    }
  }, [])

  const handleScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    chatIsAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50
    updateScrollIndicators()
  }, [updateScrollIndicators])

  const resetTurnCount = useCallback((count: number) => {
    prevTurnCountRef.current = count
  }, [])

  // Session changed -- force scroll after React renders new content
  const prevSessionChangeKeyRef = useRef(sessionChangeKey)
  useEffect(() => {
    if (sessionChangeKey === prevSessionChangeKeyRef.current) return
    prevSessionChangeKeyRef.current = sessionChangeKey

    const scrollToTop = scrollToTopOnNextChangeRef.current
    scrollToTopOnNextChangeRef.current = false

    const doScroll = () => {
      const el = chatScrollRef.current
      if (!el) return
      if (scrollToTop) {
        el.scrollTop = 0
        chatIsAtBottomRef.current = false
      } else {
        el.scrollTop = el.scrollHeight
        chatIsAtBottomRef.current = true
      }
      chatScrollOnNextRef.current = false
    }
    runAcrossFrames(doScroll)
    const timer = setTimeout(doScroll, 150)
    return () => clearTimeout(timer)
  }, [sessionChangeKey])

  // Pending message -- scroll to bottom
  useEffect(() => {
    if (pendingMessage) {
      chatScrollOnNextRef.current = true
      smoothScrollToEnd()
    }
  }, [pendingMessage, smoothScrollToEnd])

  // New turns -- auto-scroll
  const turnCount = session?.turns.length ?? 0
  useEffect(() => {
    if (turnCount === 0) return
    if (turnCount > prevTurnCountRef.current) {
      if (pendingMessage) clearPending()
      if (chatScrollOnNextRef.current || chatIsAtBottomRef.current) {
        smoothScrollToEnd()
        chatScrollOnNextRef.current = false
      }
    }
    prevTurnCountRef.current = turnCount
  }, [turnCount, pendingMessage, clearPending, smoothScrollToEnd])

  // Live content -- auto-scroll (keyed on turn count to avoid running on every session object change)
  const liveTurnCount = session?.turns.length ?? 0
  const liveLastTurnToolCount = session?.turns.at(-1)?.toolCalls.length ?? 0
  useEffect(() => {
    if (!session || !isLive) return
    if (chatIsAtBottomRef.current) smoothScrollToEnd()
    requestAnimationFrame(updateScrollIndicators)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session is only used for null check; derived counts cover reactivity
  }, [liveTurnCount, liveLastTurnToolCount, isLive, updateScrollIndicators, smoothScrollToEnd])

  return useMemo(() => ({
    chatScrollRef,
    scrollEndRef,
    canScrollUp,
    canScrollDown,
    handleScroll,
    scrollToBottomInstant,
    requestScrollToTop,
    resetTurnCount,
  }), [canScrollUp, canScrollDown, handleScroll, scrollToBottomInstant, requestScrollToTop, resetTurnCount])
}
