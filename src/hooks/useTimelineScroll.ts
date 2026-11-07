import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { TimelineScrollController, type HistoryBytes } from "@/lib/timelineScroll/controller"
import { usePendingPrompts } from "@/hooks/usePendingPrompts"
import type { ParsedSession } from "../../shared/session/types"

interface UseTimelineScrollOpts {
  session: ParsedSession | null
  pendingMessages: string[]
  consumePending: (count?: number) => void
  /** Transcript bytes behind and ahead of the paging cursor; sizes the history reserve. */
  historyBytes: HistoryBytes
}

/** The timeline's scroll engine for one app shell, plus what the chrome around it reads. */
export function useTimelineScroll({ session, pendingMessages, consumePending, historyBytes }: UseTimelineScrollOpts) {
  const [controller] = useState(() => new TimelineScrollController())
  const resetTurnCount = usePendingPrompts({ session, pendingMessages, consumePending })
  const { canScrollDown } = useSyncExternalStore(controller.subscribeIndicators, controller.getIndicators)

  useEffect(() => {
    controller.setHistoryBytes(historyBytes)
  }, [controller, historyBytes])

  // Sending a message returns the reader to the bottom to watch the reply.
  const pendingCount = pendingMessages.length
  const prevPendingRef = useRef(pendingCount)
  useLayoutEffect(() => {
    if (pendingCount > prevPendingRef.current) controller.scrollToBottom()
    prevPendingRef.current = pendingCount
  }, [controller, pendingCount])

  return useMemo(() => ({
    controller,
    chatScrollRef: controller.scrollerRef,
    canScrollDown,
    scrollToBottomInstant: controller.scrollToBottom,
    requestScrollToTop: () => controller.requestTopOnNextSession(),
    resetTurnCount,
  }), [controller, canScrollDown, resetTurnCount])
}
