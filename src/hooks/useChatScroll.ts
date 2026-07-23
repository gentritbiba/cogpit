import { useRef, useState, useCallback, useEffect, useMemo } from "react"
import type { ParsedSession } from "@/lib/types"

interface UseChatScrollOpts {
  session: ParsedSession | null
  isLive: boolean
  pendingMessages: string[]
  consumePending: (count?: number) => void
  sessionChangeKey: number
  /**
   * Summed character length across all in-flight partial assistant blocks.
   * Used only as a reactivity signal: when partials grow (streaming tokens),
   * the live-content auto-scroll effect re-runs so a user at the bottom
   * stays pinned to the bottom. Users scrolled up are not hijacked — the
   * effect still checks `chatIsAtBottomRef`.
   */
  partialContentLen?: number
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

export function useChatScroll({ session, isLive, pendingMessages, consumePending, sessionChangeKey, partialContentLen = 0 }: UseChatScrollOpts) {
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const scrollEndRef = useRef<HTMLDivElement>(null)
  const chatIsAtBottomRef = useRef(true)
  const chatScrollOnNextRef = useRef(false)
  const prevTurnCountRef = useRef(0)
  const persistedQueuedPrompts = useMemo(() => session?.turns.flatMap((turn) => (
    turn.contentBlocks.flatMap((block) => block.kind === "queued_prompt"
      ? [{
          id: JSON.stringify([block.timestamp ?? "", block.content]),
          content: block.content,
        }]
      : [])
  )) ?? [], [session?.turns])
  const queuedPromptStateRef = useRef<{
    sessionId: string | null
    ids: Set<string>
  } | null>(null)
  // When set, the next sessionChangeKey scroll will go to top instead of bottom
  const scrollToTopOnNextChangeRef = useRef(false)

  const [canScrollUp, setCanScrollUp] = useState(false)
  const [canScrollDown, setCanScrollDown] = useState(false)
  // sessionChangeKey whose initial scroll placement has completed. Consumers
  // gate scroll-up paging on this so a freshly opened session (scrollTop still
  // 0 while content renders) can't spuriously trigger older-history loads.
  const [placedKey, setPlacedKey] = useState<number | null>(null)

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
      el.scrollHeight - el.scrollTop - el.clientHeight < 150
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
    const timer = setTimeout(() => {
      doScroll()
      setPlacedKey(sessionChangeKey)
    }, 150)
    return () => clearTimeout(timer)
  }, [sessionChangeKey])

  // Pending messages -- scroll to bottom when queue changes
  const pendingCount = pendingMessages.length
  useEffect(() => {
    if (pendingCount > 0) {
      chatScrollOnNextRef.current = true
      smoothScrollToEnd()
    }
  }, [pendingCount, smoothScrollToEnd])

  // Mid-turn Claude prompts are first shown optimistically, then persisted as
  // queue-operation entries. Once the parser exposes the persisted copy,
  // consume the matching number of optimistic previews to avoid duplicates.
  useEffect(() => {
    const sessionId = session?.sessionId ?? null
    const previous = queuedPromptStateRef.current
    const ids = new Set(persistedQueuedPrompts.map((prompt) => prompt.id))
    if (!previous || previous.sessionId !== sessionId) {
      queuedPromptStateRef.current = { sessionId, ids }
      return
    }

    const added = persistedQueuedPrompts.filter((prompt) => !previous.ids.has(prompt.id))
    queuedPromptStateRef.current = { sessionId, ids }
    if (added.length === 0 || pendingCount === 0) return

    let matched = 0
    for (const prompt of added) {
      const pending = pendingMessages[matched]
      if (pending === prompt.content || (pending?.trim() === "" && prompt.content.length > 0)) {
        matched++
      }
    }
    if (matched > 0) consumePending(matched)
  }, [session?.sessionId, persistedQueuedPrompts, pendingMessages, pendingCount, consumePending])

  // New turns -- auto-scroll and consume pending messages
  const turnCount = session?.turns.length ?? 0
  useEffect(() => {
    if (turnCount === 0) return
    const newTurns = turnCount - prevTurnCountRef.current
    if (newTurns > 0) {
      if (pendingCount > 0) consumePending(Math.min(newTurns, pendingCount))
      if (chatScrollOnNextRef.current || chatIsAtBottomRef.current) {
        smoothScrollToEnd()
        chatScrollOnNextRef.current = false
      }
    }
    prevTurnCountRef.current = turnCount
  }, [turnCount, pendingCount, consumePending, smoothScrollToEnd])

  // Live content -- auto-scroll (keyed on turn count + tool count + content length to catch streaming)
  // `partialContentLen` is added so partial-assistant-message streaming
  // (rendered below the last canonical turn while the SDK streams tokens) also
  // triggers the auto-scroll effect. Without it, users at the bottom would see
  // the response grow below the fold during the pre-reconciliation window.
  const lastTurn = session?.turns.at(-1)
  const liveLastTurnToolCount = lastTurn?.toolCalls.length ?? 0
  const liveLastTurnContentLen = lastTurn?.assistantText.length ?? 0
  useEffect(() => {
    if (!session || !isLive) return
    if (chatIsAtBottomRef.current) {
      const el = chatScrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    requestAnimationFrame(updateScrollIndicators)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session is only used for null check; derived counts cover reactivity
  }, [turnCount, liveLastTurnToolCount, liveLastTurnContentLen, partialContentLen, isLive, updateScrollIndicators])

  const initialScrollDone = placedKey === sessionChangeKey

  return useMemo(() => ({
    chatScrollRef,
    scrollEndRef,
    canScrollUp,
    canScrollDown,
    initialScrollDone,
    handleScroll,
    scrollToBottomInstant,
    requestScrollToTop,
    resetTurnCount,
  }), [canScrollUp, canScrollDown, initialScrollDone, handleScroll, scrollToBottomInstant, requestScrollToTop, resetTurnCount])
}
