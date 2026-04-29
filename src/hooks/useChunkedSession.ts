import { useCallback, useRef } from "react"
import { authFetch } from "@/lib/auth"
import { sessionCache } from "@/lib/sessionCache"
import type { ParsedSession, Turn } from "@/lib/types"

interface BeforeResponse {
  headerLines: string[]
  lines: string[]
  byteOffset: number
  hasMore: boolean
}

interface UseChunkedSessionOpts {
  dirName: string | null
  fileName: string | null
  workerParse: (text: string) => Promise<ParsedSession>
  onPrependTurns: (olderTurns: Turn[], hasMore: boolean, nextByteOffset: number) => void
}

export function useChunkedSession({
  dirName,
  fileName,
  workerParse,
  onPrependTurns,
}: UseChunkedSessionOpts) {
  const loadingRef = useRef(false)

  const loadMore = useCallback(async () => {
    if (!dirName || !fileName || loadingRef.current) return
    const cached = sessionCache.get(dirName, fileName)
    if (!cached || !cached.hasMore) return

    loadingRef.current = true
    try {
      const res = await authFetch(
        `/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}?before=${cached.nextByteOffset}&count=30`
      )
      if (!res.ok) return

      const data: BeforeResponse = await res.json()
      if (data.lines.length === 0) {
        sessionCache.update(dirName, fileName, { hasMore: false })
        return
      }

      const text = [...data.headerLines, ...data.lines].join("\n")
      const olderParsed = await workerParse(text)

      sessionCache.update(dirName, fileName, {
        hasMore: data.hasMore,
        nextByteOffset: data.byteOffset,
      })

      onPrependTurns(olderParsed.turns, data.hasMore, data.byteOffset)
    } finally {
      loadingRef.current = false
    }
  }, [dirName, fileName, workerParse, onPrependTurns])

  const hasMore = dirName && fileName
    ? (sessionCache.get(dirName, fileName)?.hasMore ?? false)
    : false

  return { loadMore, hasMore }
}
