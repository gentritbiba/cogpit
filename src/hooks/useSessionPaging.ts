import { useCallback, useEffect, useRef, useState } from "react"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import type { ParsedSession, Turn } from "@/lib/types"

interface BeforeResponse {
  headerLines: string[]
  lines: string[]
  byteOffset: number
  hasMore: boolean
}

interface UseSessionPagingOpts {
  dirName: string | null
  fileName: string | null
  /** Bumped by the reducer on every session (re)load; resyncs paging state from the cache. */
  sessionChangeKey: number
  workerParse: (text: string) => Promise<ParsedSession>
  onPrependTurns: (olderTurns: Turn[]) => void
}

/** Number of complete records requested per older page (the server guarantees a minimum). */
const PAGE_COUNT = 30

/**
 * Pages older session content in via `?before=<byteOffset>&count=N`.
 *
 * `hasMore`/`isLoadingOlder` are real React state (reactive), while the
 * canonical byte offset lives in the shared `sessionCache` entry so prefetch,
 * search hydration, and re-opens all agree on where paging left off.
 */
export function useSessionPaging({
  dirName,
  fileName,
  sessionChangeKey,
  workerParse,
  onPrependTurns,
}: UseSessionPagingOpts) {
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  // Identity of the session the state above belongs to; guards against a
  // mid-flight session switch prepending turns into the wrong session.
  const identityRef = useRef("")
  const flightRef = useRef<symbol | null>(null)

  const identity = `${dirName ?? ""}::${fileName ?? ""}::${sessionChangeKey}`

  useEffect(() => {
    identityRef.current = identity
    flightRef.current = null
    setIsLoadingOlder(false)
    setHasMore(
      dirName && fileName ? (sessionCache.get(dirName, fileName)?.hasMore ?? false) : false,
    )
  }, [identity, dirName, fileName, sessionChangeKey])

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
        `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}?before=${cached.nextByteOffset}&count=${PAGE_COUNT}`,
      )
      if (!res.ok) return 0

      const data: BeforeResponse = await res.json()
      const hasMorePages = data.lines.length > 0 && data.hasMore
      sessionCache.update(dirName, fileName, {
        hasMore: hasMorePages,
        nextByteOffset: data.byteOffset,
      })
      if (identityRef.current === key) setHasMore(hasMorePages)
      if (data.lines.length === 0) return 0

      const headerLineSet = new Set(data.headerLines)
      const pageLines = data.lines.filter((line) => !headerLineSet.has(line))
      const olderParsed = await workerParse([...data.headerLines, ...pageLines].join("\n"))
      if (identityRef.current !== key) return 0
      onPrependTurns(olderParsed.turns)
      return olderParsed.turns.length
    } finally {
      if (flightRef.current === flight) {
        flightRef.current = null
        if (identityRef.current === key) setIsLoadingOlder(false)
      }
    }
  }, [dirName, fileName, sessionChangeKey, workerParse, onPrependTurns])

  return { loadMore, hasMore, isLoadingOlder }
}
