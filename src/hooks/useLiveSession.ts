import { useEffect, useRef, useState } from "react"
import { authUrl } from "@/lib/auth"
import type { ParsedSession } from "@/lib/types"
import type { AgentKind } from "@/lib/sessionSource"
import { sessionCache } from "@/lib/sessionCache"

export interface SessionSource {
  dirName: string
  fileName: string
  rawText: string
  agentKind?: AgentKind
}

export type SseConnectionState = "connecting" | "connected" | "disconnected"

export function useLiveSession(
  source: SessionSource | null,
  onUpdate: (session: ParsedSession) => void,
  workerParse: (text: string) => Promise<ParsedSession>,
  workerAppend: (existing: ParsedSession, newText: string) => Promise<ParsedSession>,
  onReconnect?: () => void
) {
  const [isLive, setIsLive] = useState(false)
  const [sseState, setSseState] = useState<SseConnectionState>("disconnected")
  const [isCompacting, setIsCompacting] = useState(false)
  const textRef = useRef("")
  const sessionRef = useRef<ParsedSession | null>(null)
  const sseStateRef = useRef<SseConnectionState>("disconnected")
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect
  const workerParseRef = useRef(workerParse)
  workerParseRef.current = workerParse
  const workerAppendRef = useRef(workerAppend)
  workerAppendRef.current = workerAppend
  const wasDisconnectedRef = useRef(false)

  const dirName = source?.dirName ?? null
  const fileName = source?.fileName ?? null
  const rawText = source?.rawText ?? ""

  // Reset accumulated text and cached session when source changes
  useEffect(() => {
    textRef.current = rawText
    if (rawText) {
      workerParseRef.current(rawText).then((parsed) => {
        sessionRef.current = parsed
      })
    } else {
      sessionRef.current = null
      setIsLive(false)
    }
  }, [rawText])

  // SSE reconnects when rawText changes (e.g. after JSONL truncation from undo).
  // rawText only changes on explicit session load/reload, not during SSE streaming.
  useEffect(() => {
    if (!dirName || !fileName) {
      setIsLive(false)
      setSseState("disconnected")
      return
    }

    setSseState("connecting")

    const url = `/api/watch/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}`
    const es = new EventSource(authUrl(url))
    let staleTimer: ReturnType<typeof setTimeout> | null = null

    const resetStaleTimer = (ms = 30_000) => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => setIsLive(false), ms)
    }

    // Throttle React updates: parse every SSE message eagerly (data stays fresh)
    // but only trigger a React rerender at most every 100ms to avoid jank.
    let pendingUpdate = false
    let rafId: number | null = null
    // Chain parse promises to prevent race conditions: each parse starts
    // from the result of the previous one, so rapid SSE messages don't
    // overwrite each other's results.
    let parseChain: Promise<ParsedSession | null> = Promise.resolve(null)

    const flushUpdate = () => {
      pendingUpdate = false
      rafId = null
      if (sessionRef.current) {
        onUpdateRef.current(sessionRef.current)
      }
    }

    es.onopen = () => {
      if (sseStateRef.current !== "connected") {
        const wasDisconnected = wasDisconnectedRef.current
        wasDisconnectedRef.current = false
        sseStateRef.current = "connected"
        setSseState("connected")
        if (wasDisconnected) {
          onReconnectRef.current?.()
        }
      }
    }

    es.onmessage = (event) => {
      try {
        if (sseStateRef.current !== "connected") {
          sseStateRef.current = "connected"
          setSseState("connected")
        }
        const data = JSON.parse(event.data)
        if (data.type === "init") {
          if (data.recentlyActive) {
            setIsLive(true)
            // Short confirmation timer: if no lines arrive within 5s,
            // the session is likely dead despite the recent file mtime.
            resetStaleTimer(5_000)
          } else {
            resetStaleTimer()
          }
        } else if (data.type === "compacting_in_progress") {
          setIsLive(true)
          setIsCompacting(true)
          resetStaleTimer()
        } else if (data.type === "lines" && data.lines.length > 0) {
          setIsLive(true)
          setIsCompacting(false)
          resetStaleTimer()

          const newText = data.lines.join("\n") + "\n"
          textRef.current += newText

          // Chain parses: each starts from the previous result to prevent
          // race conditions when rapid SSE messages arrive before prior
          // parses complete. Use sessionRef.current as fallback for the
          // first call (the initial session was parsed by the rawText effect).
          parseChain = parseChain.then((chainedSession) => {
            const currentSession = chainedSession ?? sessionRef.current
            return currentSession
              ? workerAppendRef.current(currentSession, newText)
              : workerParseRef.current(textRef.current)
          }).then((result) => {
            sessionRef.current = result
            // Update cache
            if (dirName && fileName) {
              sessionCache.update(dirName, fileName, { parsed: result })
              sessionCache.updateRawText(dirName, fileName, textRef.current)
            }
            // Coalesce rapid updates into a single React render
            if (!pendingUpdate) {
              pendingUpdate = true
              rafId = requestAnimationFrame(flushUpdate)
            }
            return result
          })
        }
      } catch (err) {
        console.error("[useLiveSession] Error processing SSE message:", err)
      }
    }

    es.onerror = () => {
      setIsLive(false)
      wasDisconnectedRef.current = sseStateRef.current === "connected"
      sseStateRef.current = "disconnected"
      setSseState("disconnected")
    }

    return () => {
      es.close()
      setIsLive(false)
      sseStateRef.current = "disconnected"
      setSseState("disconnected")
      if (staleTimer) clearTimeout(staleTimer)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [dirName, fileName, rawText])

  return { isLive, sseState, isCompacting }
}
