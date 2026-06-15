import { useEffect, useRef, useState } from "react"
import { authUrl } from "@/lib/auth"
import type { ParsedSession } from "@/lib/types"
import type { AgentKind } from "@/lib/sessionSource"
import { sessionCache } from "@/lib/sessionCache"
import {
  applyDeltas,
  applySnapshot,
  reconcileWithLines,
  sweepStale,
  EMPTY_OVERLAY,
  type StreamingOverlay,
} from "@/lib/streamingOverlay"

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
  onReconnect?: () => void,
  /**
   * Optional already-parsed session matching `source.rawText`. When provided,
   * `useLiveSession` seeds its internal `sessionRef` synchronously instead of
   * re-parsing `rawText` on the main thread / in the worker. This eliminates
   * a duplicate parse on every session switch (the caller typically already
   * parsed rawText once to build `source`).
   */
  initialSession?: ParsedSession | null,
) {
  const [isLive, setIsLive] = useState(false)
  const [sseState, setSseState] = useState<SseConnectionState>("disconnected")
  const [isCompacting, setIsCompacting] = useState(false)
  // Ephemeral token-streaming overlay (SDK-driven sessions only). Never
  // touches the worker/ParsedSession pipeline — see src/lib/streamingOverlay.
  const [streamingOverlay, setStreamingOverlay] = useState<StreamingOverlay>(EMPTY_OVERLAY)
  const textRef = useRef("")
  const sessionRef = useRef<ParsedSession | null>(null)
  const overlayRef = useRef<StreamingOverlay>(EMPTY_OVERLAY)
  const sseStateRef = useRef<SseConnectionState>("disconnected")
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect
  const workerParseRef = useRef(workerParse)
  workerParseRef.current = workerParse
  const workerAppendRef = useRef(workerAppend)
  workerAppendRef.current = workerAppend
  // Track the most recently provided initialSession so the rawText-reset
  // effect can use it without re-running on every state.session change.
  const initialSessionRef = useRef(initialSession ?? null)
  initialSessionRef.current = initialSession ?? null
  const wasDisconnectedRef = useRef(false)

  const dirName = source?.dirName ?? null
  const fileName = source?.fileName ?? null
  const rawText = source?.rawText ?? ""

  // Reset accumulated text and cached session when source changes
  useEffect(() => {
    textRef.current = rawText
    if (!rawText) {
      sessionRef.current = null
      setIsLive(false)
      return
    }
    // Fast path: caller already parsed rawText and handed us the result.
    // Avoid a duplicate worker parse on every session switch.
    const seeded = initialSessionRef.current
    if (seeded) {
      sessionRef.current = seeded
      return
    }
    // Fallback: no pre-parsed session available — parse rawText ourselves.
    workerParseRef.current(rawText).then((parsed) => {
      sessionRef.current = parsed
    })
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

    // ── SSE burst coalescing ────────────────────────────────────────────
    // Heavy bash output produces many SSE messages per second. If we send
    // each one to the parser worker individually, every postMessage pays the
    // cost of a structured-clone of the entire ParsedSession on BOTH ends —
    // ~O(session size) per message. For a 5 MB session that burst can starve
    // the renderer for seconds.
    //
    // Instead, accumulate incoming text in `pendingText` while the worker is
    // busy and flush it as a single batch when the worker becomes idle.
    // Ordering is preserved because text fragments are appended in arrival
    // order and only one worker call is in flight at a time.
    let pendingText = ""
    let workerBusy = false
    let closed = false
    let pendingUpdate = false
    let rafId: number | null = null

    const flushUpdate = () => {
      pendingUpdate = false
      rafId = null
      if (sessionRef.current) {
        onUpdateRef.current(sessionRef.current)
      }
    }

    const scheduleUpdate = () => {
      if (pendingUpdate) return
      pendingUpdate = true
      rafId = requestAnimationFrame(flushUpdate)
    }

    // ── Streaming overlay flushing ──────────────────────────────────────
    // Overlay deltas arrive at up to ~13 Hz; mutate the ref and publish to
    // React state at most once per animation frame. Separate scheduler from
    // scheduleUpdate so overlay churn never forces a session re-render.
    let overlayDirty = false
    let overlayRafId: number | null = null
    let staleSweep: ReturnType<typeof setInterval> | null = null

    const flushOverlay = () => {
      overlayDirty = false
      overlayRafId = null
      setStreamingOverlay(overlayRef.current)
    }

    const scheduleOverlayFlush = () => {
      if (overlayDirty) return
      overlayDirty = true
      overlayRafId = requestAnimationFrame(flushOverlay)
    }

    const setOverlay = (next: StreamingOverlay) => {
      if (next === overlayRef.current) return
      overlayRef.current = next
      scheduleOverlayFlush()
      // Stale-sweep runs only while the overlay has content: stopped
      // messages whose JSONL line never matched are dropped after 10 s.
      if (next.length > 0 && !staleSweep) {
        staleSweep = setInterval(() => {
          const swept = sweepStale(overlayRef.current)
          if (swept !== overlayRef.current) {
            overlayRef.current = swept
            scheduleOverlayFlush()
          }
          if (overlayRef.current.length === 0 && staleSweep) {
            clearInterval(staleSweep)
            staleSweep = null
          }
        }, 5_000)
      }
    }

    const clearOverlay = () => setOverlay(EMPTY_OVERLAY)

    const flushToWorker = () => {
      if (closed || workerBusy || !pendingText) return
      const toFlush = pendingText
      pendingText = ""
      workerBusy = true

      const base = sessionRef.current
      const parsePromise = base
        ? workerAppendRef.current(base, toFlush)
        : workerParseRef.current(textRef.current)

      parsePromise
        .then((result) => {
          if (closed) return
          sessionRef.current = result
          if (dirName && fileName) {
            sessionCache.update(dirName, fileName, { parsed: result })
            sessionCache.updateRawText(dirName, fileName, textRef.current)
          }
          scheduleUpdate()
        })
        .catch((err) => {
          console.error("[useLiveSession] worker parse failed:", err)
        })
        .finally(() => {
          workerBusy = false
          // Drain anything that accumulated while the worker was busy — this
          // is where the O(1) burst compression happens.
          if (!closed && pendingText) flushToWorker()
        })
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
          clearOverlay()
          resetStaleTimer()
        } else if (data.type === "stream_snapshot") {
          // Mid-turn connect/reconnect: replace the overlay wholesale.
          setIsLive(true)
          resetStaleTimer()
          setOverlay(applySnapshot(data.messages ?? []))
        } else if (data.type === "stream_delta") {
          setIsLive(true)
          resetStaleTimer()
          setOverlay(applyDeltas(overlayRef.current, data.events ?? []))
        } else if (data.type === "stream_clear") {
          clearOverlay()
        } else if (data.type === "lines" && data.lines.length > 0) {
          setIsLive(true)
          setIsCompacting(false)
          resetStaleTimer()

          // Drop overlay messages superseded by their complete JSONL line.
          setOverlay(reconcileWithLines(overlayRef.current, data.lines))

          const newText = data.lines.join("\n") + "\n"
          textRef.current += newText
          pendingText += newText
          flushToWorker()
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
      // EventSource auto-reconnects; a fresh stream_snapshot will rebuild the
      // overlay, so drop the (possibly gapped) current one.
      clearOverlay()
    }

    return () => {
      // Drop any in-flight worker result so a stale parse from this source
      // can't stomp sessionRef.current after the next source is mounted.
      closed = true
      es.close()
      setIsLive(false)
      sseStateRef.current = "disconnected"
      setSseState("disconnected")
      if (staleTimer) clearTimeout(staleTimer)
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (overlayRafId !== null) cancelAnimationFrame(overlayRafId)
      if (staleSweep) clearInterval(staleSweep)
      overlayRef.current = EMPTY_OVERLAY
      setStreamingOverlay(EMPTY_OVERLAY)
    }
  }, [dirName, fileName, rawText])

  return { isLive, sseState, isCompacting, streamingOverlay }
}
