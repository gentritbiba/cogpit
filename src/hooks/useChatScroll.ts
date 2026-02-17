import { useRef, useState, useCallback, useEffect } from "react"
import type { ParsedSession } from "@/lib/types"

interface UseChatScrollOpts {
  session: ParsedSession | null
  isLive: boolean
  pendingMessage: string | null
  clearPending: () => void
}

export function useChatScroll({ session, isLive, pendingMessage, clearPending }: UseChatScrollOpts) {
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const scrollEndRef = useRef<HTMLDivElement>(null)
  const chatIsAtBottomRef = useRef(true)
  const chatScrollOnNextRef = useRef(false)
  const prevTurnCountRef = useRef(0)

  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)

  const scrollToBottomInstant = useCallback(() => {
    requestAnimationFrame(() => {
      const el = chatScrollRef.current
      if (el) el.scrollTop = el.scrollHeight
      chatIsAtBottomRef.current = true
      chatScrollOnNextRef.current = false
    })
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

  // Pending message → scroll to bottom
  useEffect(() => {
    if (pendingMessage) {
      chatScrollOnNextRef.current = true
      requestAnimationFrame(() => {
        scrollEndRef.current?.scrollIntoView({ behavior: "smooth" })
      })
    }
  }, [pendingMessage])

  // New turns → auto-scroll
  const turnCount = session?.turns.length ?? 0
  useEffect(() => {
    if (turnCount === 0) return
    if (turnCount > prevTurnCountRef.current) {
      if (pendingMessage) {
        clearPending()
      }
      if (chatScrollOnNextRef.current || chatIsAtBottomRef.current) {
        requestAnimationFrame(() => {
          scrollEndRef.current?.scrollIntoView({ behavior: "smooth" })
        })
        chatScrollOnNextRef.current = false
      }
    }
    prevTurnCountRef.current = turnCount
  }, [turnCount, pendingMessage, clearPending])

  // Live content → auto-scroll
  useEffect(() => {
    if (!session || !isLive) return
    if (chatIsAtBottomRef.current) {
      requestAnimationFrame(() => {
        scrollEndRef.current?.scrollIntoView({ behavior: "smooth" })
      })
    }
    requestAnimationFrame(updateScrollIndicators)
  }, [session, isLive, updateScrollIndicators])

  return {
    chatScrollRef,
    scrollEndRef,
    canScrollUp,
    canScrollDown,
    handleScroll,
    scrollToBottomInstant,
    resetTurnCount,
  }
}
