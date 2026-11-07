import { useCallback, useEffect, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import { prependTurns } from "@/lib/timelinePaging"
import type { HistoryBytes } from "@/lib/timelineScroll/controller"
import { RESULT_PROJECTION } from "../../shared/contracts/toolResults"
import type { ParsedSession, Turn } from "../../shared/session/types"

interface BeforeResponse {
  headerLines: string[]
  lines: string[]
  byteOffset: number
  hasMore: boolean
  /** Set by servers that honour `unit=turns`: the page holds whole turns. */
  unit?: "turns"
  /** A turn too large for one page: this page starts partway into it. */
  cutTurn?: boolean
}

interface UseSessionPagingOpts {
  dirName: string | null
  fileName: string | null
  /** Bumped by the reducer on every session (re)load; resyncs paging state from the cache. */
  sessionChangeKey: number
  workerParse: (text: string) => Promise<ParsedSession>
  /** Receives every turn loaded above the live window, oldest first. */
  onOlderTurns: (olderTurns: Turn[]) => void
}

/** Number of complete records requested per older page (the server guarantees a minimum). */
const PAGE_COUNT = 30

const NO_HISTORY: HistoryBytes = { remaining: 0, loaded: 0 }

/** Transcript bytes before the paging cursor, and between it and the live end. */
function historyBytesOf(entry: { nextByteOffset: number; hasMore: boolean; source: { watchOffset?: number } } | undefined): HistoryBytes {
  if (!entry?.hasMore) return NO_HISTORY
  return { remaining: entry.nextByteOffset, loaded: Math.max(0, (entry.source.watchOffset ?? 0) - entry.nextByteOffset) }
}

/**
 * Pages older session content in via `?before=<byteOffset>&count=N&unit=turns`.
 * Servers that predate `unit=turns` ignore it and answer with line pages.
 *
 * `hasMore`/`isLoadingOlder` are real React state (reactive), while the byte
 * cursor and the pages it has already consumed live together in the shared
 * `sessionCache` entry — so prefetch, search hydration, and re-opens all agree
 * on both where paging left off and what it found there. When to page is the
 * timeline scroll engine's decision; this hook only fetches.
 */
export function useSessionPaging({
  dirName,
  fileName,
  sessionChangeKey,
  workerParse,
  onOlderTurns,
}: UseSessionPagingOpts) {
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [historyBytes, setHistoryBytes] = useState<HistoryBytes>(NO_HISTORY)
  // Identity of the session the state above belongs to; guards against a
  // mid-flight session switch prepending turns into the wrong session.
  const identityRef = useRef("")
  const flightRef = useRef<symbol | null>(null)
  // Whether the paging cursor sits between two whole turns. Unknown at first:
  // the tail (or an older server) may have cut a turn there.
  const cursorOnTurnRef = useRef(false)

  const identity = `${dirName ?? ""}::${fileName ?? ""}::${sessionChangeKey}`

  useEffect(() => {
    identityRef.current = identity
    flightRef.current = null
    cursorOnTurnRef.current = false
    setIsLoadingOlder(false)
    const cached = dirName && fileName ? sessionCache.get(dirName, fileName) : undefined
    setHasMore(cached?.hasMore ?? false)
    setHistoryBytes(historyBytesOf(cached))
    // Re-attach history paged in before this session was last closed. The
    // cached byte cursor already sits past those pages, so without this they
    // would be an unreachable gap in the transcript.
    if (cached && cached.olderTurns.length > 0) onOlderTurns(cached.olderTurns)
  }, [identity, dirName, fileName, sessionChangeKey, onOlderTurns])

  const loadMore = useCallback(async (): Promise<number> => {
    if (!dirName || !fileName || flightRef.current) return 0
    const key = `${dirName}::${fileName}::${sessionChangeKey}`
    const cached = sessionCache.get(dirName, fileName)
    if (!cached?.hasMore) {
      if (identityRef.current === key) setHasMore(false)
      return 0
    }

    const flight = Symbol("paging-flight")
    flightRef.current = flight
    setIsLoadingOlder(true)
    try {
      const res = await authFetch(
        `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}?before=${cached.nextByteOffset}&count=${PAGE_COUNT}&unit=turns&projection=${RESULT_PROJECTION}`,
      )
      if (!res.ok) return 0

      const data: BeforeResponse = await res.json()
      const hasMorePages = data.lines.length > 0 && data.hasMore
      if (identityRef.current === key) setHasMore(hasMorePages)
      if (data.lines.length === 0) {
        sessionCache.update(dirName, fileName, {
          hasMore: hasMorePages,
          nextByteOffset: data.byteOffset,
        })
        if (identityRef.current === key) setHistoryBytes(historyBytesOf(sessionCache.get(dirName, fileName)))
        return 0
      }

      // A line page can repeat header records at its start; a turn page never does.
      const byTurns = data.unit === "turns"
      const headerLineSet = new Set(data.headerLines)
      const pageLines = byTurns ? data.lines : data.lines.filter((line) => !headerLineSet.has(line))
      const olderParsed = await workerParse([...data.headerLines, ...pageLines].join("\n"))

      // The byte cursor and the pages it consumed advance together: a cursor
      // that moves without them strands that history behind it forever.
      const history = prependTurns(cached.olderTurns, olderParsed.turns, cached.source.agentKind, {
        stitch: !cursorOnTurnRef.current,
      })
      if (identityRef.current === key) cursorOnTurnRef.current = byTurns && !data.cutTurn
      sessionCache.update(dirName, fileName, {
        hasMore: hasMorePages,
        nextByteOffset: data.byteOffset,
        olderTurns: history,
      })

      if (identityRef.current !== key) return 0
      setHistoryBytes(historyBytesOf(sessionCache.get(dirName, fileName)))
      onOlderTurns(history)
      return olderParsed.turns.length
    } finally {
      if (flightRef.current === flight) {
        flightRef.current = null
        if (identityRef.current === key) setIsLoadingOlder(false)
      }
    }
  }, [dirName, fileName, sessionChangeKey, workerParse, onOlderTurns])

  return { loadMore, hasMore, isLoadingOlder, historyBytes }
}
