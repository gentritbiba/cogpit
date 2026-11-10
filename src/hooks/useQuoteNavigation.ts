import { useCallback, useEffect, useRef, useState } from "react"
import type { QuoteSource } from "../../shared/session/composerContext"
import type { SessionView } from "../../shared/session/sessionDigest"
import type { SessionSource } from "@/lib/sessionSource"
import { turnKeysOf } from "@/lib/timelineScroll/turnKeys"

/** Older pages a jump loads looking for its turn before it calls the source missing. */
export const QUOTE_SEARCH_PAGES = 20
/** How long a jump waits for another session to open. */
const OPEN_TIMEOUT_MS = 15_000
/** How long a found turn waits for the timeline to land on it (a mobile tab switch) before the jump gives up. */
const LAND_MS = 3_000

interface Pending {
  source: QuoteSource
  text: string
  turn?: number | null
  pages: number
  /** The turn is found and the jump to it has started its `LAND_MS` clock. */
  landing: boolean
  /** A page or a jump is in flight. */
  loading: boolean
  /** A jump did not land; the next time the timeline lays out tries again. */
  waiting: boolean
  resolve: (found: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

interface Inputs {
  /** The open session, read when a jump looks for its turn. */
  getSession: () => SessionView | null
  sessionSource: SessionSource | null
  loadSession: (dirName: string, fileName: string) => void
  /** Moves the timeline to the turn with this key; resolves false when it could not land. */
  jumpToTurn: (turnKey: string) => Promise<boolean>
  /** Calls `listener` after the timeline lays out; returns the unsubscribe. */
  subscribeTimeline: (listener: () => void) => () => void
  onNavigate?: () => void
  historyReady?: boolean
  hasMore: boolean
  loadMore: () => Promise<number>
}

/** The turn a quote came from: by its id, or by the quoted text when the parser renumbered turns. */
export function quoteTurnIndex(session: SessionView, source: QuoteSource, text: string): number {
  const byId = session.turns.findIndex((turn) => turn.id === source.turnId)
  if (byId >= 0) return byId
  if (!text) return -1
  const probe = text.slice(0, 200)
  return session.turns.findIndex((turn) => turn.assistantText.some((reply) => reply.includes(probe)))
}

function shows(sessionSource: SessionSource | null, source: QuoteSource): boolean {
  return sessionSource?.dirName === source.dirName && sessionSource.fileName === source.fileName
}

/**
 * Jumps to a quoted reply's source: opening its session when another is
 * shown, and paging older history in (at most `QUOTE_SEARCH_PAGES` pages,
 * one at a time) when its turn is above what is loaded. Resolves false when
 * the source cannot be found — deleted, denied or out of reach — and the
 * saved quote stands on its own.
 */
export function useQuoteNavigation(inputs: Inputs): (source: QuoteSource, text: string, turn?: number | null) => Promise<boolean> {
  const latest = useRef(inputs)
  latest.current = inputs
  const pendingRef = useRef<Pending | null>(null)
  const [, rerender] = useState(0)

  const settle = useCallback((found: boolean) => {
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    clearTimeout(pending.timer)
    pending.resolve(found)
  }, [])

  const evaluate = useCallback(() => {
    const pending = pendingRef.current
    const { getSession, sessionSource, hasMore, loadMore, jumpToTurn, historyReady } = latest.current
    const session = getSession()
    if (historyReady === false || !pending || pending.loading || pending.waiting || !session || !shows(sessionSource, pending.source)) return
    let index = quoteTurnIndex(session, pending.source, pending.text)
    // Ordinals count from the transcript start, never from a loaded tail.
    if (index < 0 && !hasMore && pending.turn != null && Number.isInteger(pending.turn)
      && pending.turn >= 0 && pending.turn < session.turns.length) index = pending.turn
    if (index >= 0) {
      // By key, so a page of older history landing meanwhile cannot shift the target.
      const turnKey = turnKeysOf(session.turns)[index]
      if (!pending.landing) {
        pending.landing = true
        clearTimeout(pending.timer)
        pending.timer = setTimeout(() => settle(false), LAND_MS)
      }
      pending.loading = true
      void jumpToTurn(turnKey).then((landed) => {
        if (pendingRef.current !== pending) return
        if (landed) {
          settle(true)
          return
        }
        pending.loading = false
        pending.waiting = true
      })
      return
    }
    if (!hasMore || pending.pages >= QUOTE_SEARCH_PAGES) {
      settle(false)
      return
    }
    pending.pages++
    pending.loading = true
    void loadMore().then(() => {
      // Look again once React has rendered the page that came in.
      pending.loading = false
      if (pendingRef.current === pending) rerender((tick) => tick + 1)
    }, () => settle(false))
  }, [settle])

  // Each render may bring the session that opened or the page that loaded.
  useEffect(evaluate)
  const { subscribeTimeline } = inputs
  useEffect(() => subscribeTimeline(() => {
    const pending = pendingRef.current
    if (!pending?.waiting) return
    pending.waiting = false
    evaluate()
  }), [subscribeTimeline, evaluate])
  useEffect(() => () => settle(false), [settle])

  return useCallback((source: QuoteSource, text: string, turn?: number | null) => new Promise<boolean>((resolve) => {
    settle(false)
    pendingRef.current = { source, text, turn, pages: 0, landing: false, loading: false, waiting: false, resolve, timer: setTimeout(() => settle(false), OPEN_TIMEOUT_MS) }
    const { sessionSource, loadSession, onNavigate } = latest.current
    onNavigate?.()
    if (shows(sessionSource, source)) evaluate()
    else loadSession(source.dirName, source.fileName)
  }), [settle, evaluate])
}
