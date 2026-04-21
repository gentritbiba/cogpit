import { useEffect, useRef, useState } from "react"
import { authUrl } from "@/lib/auth"
import type {
  ParsedSession,
  PartialAssistantMessage,
  StreamEventSSE,
} from "@/lib/types"
import type { AgentKind } from "@/lib/sessionSource"
import { sessionCache } from "@/lib/sessionCache"
import { applyStreamEvent, dropByMessageIds } from "@/lib/partialMessages"

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
  const [partialMessages, setPartialMessages] = useState<
    Map<string, PartialAssistantMessage>
  >(new Map())
  const textRef = useRef("")
  const sessionRef = useRef<ParsedSession | null>(null)
  // Mirror of `partialMessages` for synchronous reads inside SSE handlers.
  const partialsRef = useRef<Map<string, PartialAssistantMessage>>(new Map())
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
    // Dump any in-flight partials — they belong to the previous source.
    // Reset synchronously — rAF-coalescing is for high-frequency partial
    // updates; resets are rare, must not race with pending flushes, and
    // must take effect before any new stream_events are handled.
    if (partialsRef.current.size > 0) {
      partialsRef.current = new Map()
      setPartialMessages(partialsRef.current)
    }
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

    // Clear in-flight partials from the previous SSE channel — they belong to
    // a different session and must not bleed into the new one. Separate from
    // the rawText-reset effect above because source-switch can keep rawText
    // constant (e.g. two empty-but-distinct sessions).
    // Reset: see comment above.
    if (partialsRef.current.size > 0) {
      partialsRef.current = new Map()
      setPartialMessages(partialsRef.current)
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
    let pendingPartialsFlush = false
    // `pendingSessionUpdate` is only set when the worker produces a *new*
    // canonical ParsedSession. Partial-only stream frames leave this flag
    // false so `flushUpdate` can skip dispatching UPDATE_SESSION — otherwise
    // every text_delta would rebuild the root SessionState object and trigger
    // an App-level re-render even though the canonical session is unchanged.
    let pendingSessionUpdate = false
    let rafId: number | null = null

    const flushUpdate = () => {
      pendingUpdate = false
      rafId = null
      if (pendingPartialsFlush) {
        pendingPartialsFlush = false
        setPartialMessages(partialsRef.current)
      }
      if (pendingSessionUpdate && sessionRef.current) {
        pendingSessionUpdate = false
        onUpdateRef.current(sessionRef.current)
      }
    }

    const scheduleUpdate = () => {
      if (pendingUpdate) return
      pendingUpdate = true
      rafId = requestAnimationFrame(flushUpdate)
    }

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
          // Canonical session changed — dispatch UPDATE_SESSION on the next
          // rAF flush. This is the ONLY place that sets pendingSessionUpdate;
          // the stream_event branch updates partials only.
          pendingSessionUpdate = true
          if (dirName && fileName) {
            sessionCache.update(dirName, fileName, { parsed: result })
            sessionCache.updateRawText(dirName, fileName, textRef.current)
          }
          // Reconcile: drop any partial whose message.id now appears in the
          // canonical JSONL stream. We scan `rawMessages` (the raw JSONL
          // entries) rather than `turns` because `Turn.contentBlocks` doesn't
          // carry the assistant message id — only the raw message does.
          if (partialsRef.current.size > 0) {
            const idsInSession = new Set<string>()
            for (const raw of result.rawMessages) {
              if (raw.type === "assistant") {
                const msg = (raw as { message?: { id?: string } }).message
                if (msg?.id) idsInSession.add(msg.id)
              }
            }
            const trimmed = dropByMessageIds(partialsRef.current, idsInSession)
            if (trimmed !== partialsRef.current) {
              partialsRef.current = trimmed
              pendingPartialsFlush = true
            }
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
          resetStaleTimer()
        } else if (data.type === "lines" && data.lines.length > 0) {
          setIsLive(true)
          setIsCompacting(false)
          resetStaleTimer()

          const newText = data.lines.join("\n") + "\n"
          textRef.current += newText
          pendingText += newText
          flushToWorker()
        } else if (data.type === "stream_event") {
          const next = applyStreamEvent(
            partialsRef.current,
            data as StreamEventSSE,
          )
          if (next !== partialsRef.current) {
            partialsRef.current = next
            pendingPartialsFlush = true
            scheduleUpdate()
          }
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
      // Drop in-flight partials — they belong to a stream that was cut off.
      // A reconnect will replay canonical JSONL; partials for the interrupted
      // turn will never complete and would otherwise linger forever.
      if (partialsRef.current.size > 0) {
        partialsRef.current = new Map()
        setPartialMessages(partialsRef.current)
      }
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
    }
  }, [dirName, fileName, rawText])

  return { isLive, sseState, isCompacting, partialMessages }
}
