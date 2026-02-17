import { useEffect, useRef, useState } from "react"
import { parseSession, parseSessionAppend } from "@/lib/parser"
import type { ParsedSession } from "@/lib/types"

export interface SessionSource {
  dirName: string
  fileName: string
  rawText: string
}

export function useLiveSession(
  source: SessionSource | null,
  onUpdate: (session: ParsedSession) => void
) {
  const [isLive, setIsLive] = useState(false)
  const textRef = useRef("")
  const sessionRef = useRef<ParsedSession | null>(null)
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  const dirName = source?.dirName ?? null
  const fileName = source?.fileName ?? null
  const rawText = source?.rawText ?? ""

  // Reset accumulated text and cached session when source changes
  useEffect(() => {
    textRef.current = rawText
    sessionRef.current = rawText ? parseSession(rawText) : null
    if (!rawText) {
      setIsLive(false)
    }
  }, [rawText])

  // SSE reconnects when rawText changes (e.g. after JSONL truncation from undo).
  // rawText only changes on explicit session load/reload, not during SSE streaming.
  useEffect(() => {
    if (!dirName || !fileName) {
      setIsLive(false)
      return
    }

    const url = `/api/watch/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`
    const es = new EventSource(url)
    let staleTimer: ReturnType<typeof setTimeout> | null = null

    const resetStaleTimer = () => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => setIsLive(false), 30000)
    }

    // Throttle React updates: parse every SSE message eagerly (data stays fresh)
    // but only trigger a React rerender at most every 100ms to avoid jank.
    let pendingUpdate = false
    let rafId: number | null = null

    const flushUpdate = () => {
      pendingUpdate = false
      rafId = null
      if (sessionRef.current) {
        onUpdateRef.current(sessionRef.current)
      }
    }

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === "init") {
          resetStaleTimer()
        } else if (data.type === "lines" && data.lines.length > 0) {
          setIsLive(true)
          resetStaleTimer()

          const newText = data.lines.join("\n") + "\n"
          textRef.current += newText
          if (sessionRef.current) {
            sessionRef.current = parseSessionAppend(sessionRef.current, newText)
          } else {
            sessionRef.current = parseSession(textRef.current)
          }

          // Coalesce rapid SSE updates into a single React render
          if (!pendingUpdate) {
            pendingUpdate = true
            rafId = requestAnimationFrame(flushUpdate)
          }
        }
      } catch (err) {
        console.error("[useLiveSession] Error processing SSE message:", err)
      }
    }

    es.onerror = () => {
      setIsLive(false)
    }

    return () => {
      es.close()
      setIsLive(false)
      if (staleTimer) clearTimeout(staleTimer)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [dirName, fileName, rawText])

  return { isLive }
}
