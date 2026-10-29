import { useCallback, useEffect, useRef, useState } from "react"
import type { QuoteSource } from "../../shared/session/composerContext"
import type { ParsedSession } from "../../shared/session/types"
import type { SessionSource } from "@/hooks/useLiveSession"

/** Older pages a jump loads looking for its turn before it calls the source missing. */
export const QUOTE_SEARCH_PAGES = 20
/** How long a jump waits for another session to open. */
const OPEN_TIMEOUT_MS = 15_000

interface Pending {
  source: QuoteSource
  text: string
  pages: number
  loading: boolean
  resolve: (found: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

interface Inputs {
  session: ParsedSession | null
  sessionSource: SessionSource | null
  loadSession: (dirName: string, fileName: string) => void
  jumpToTurn: (index: number) => void
  hasMore: boolean
  loadMore: () => Promise<number>
}

/** The turn a quote came from: by its id, or by the quoted text when the parser renumbered turns. */
export function quoteTurnIndex(session: ParsedSession, source: QuoteSource, text: string): number {
  const byId = session.turns.findIndex((turn) => turn.id === source.turnId)
  if (byId >= 0) return byId
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
export function useQuoteNavigation(inputs: Inputs): (source: QuoteSource, text: string) => Promise<boolean> {
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
    const { session, sessionSource, hasMore, loadMore, jumpToTurn } = latest.current
    if (!pending || pending.loading || !session || !shows(sessionSource, pending.source)) return
    const index = quoteTurnIndex(session, pending.source, pending.text)
    if (index >= 0) {
      jumpToTurn(index)
      settle(true)
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
  useEffect(() => () => settle(false), [settle])

  return useCallback((source: QuoteSource, text: string) => new Promise<boolean>((resolve) => {
    settle(false)
    pendingRef.current = { source, text, pages: 0, loading: false, resolve, timer: setTimeout(() => settle(false), OPEN_TIMEOUT_MS) }
    const { sessionSource, loadSession } = latest.current
    if (shows(sessionSource, source)) evaluate()
    else loadSession(source.dirName, source.fileName)
  }), [settle, evaluate])
}
