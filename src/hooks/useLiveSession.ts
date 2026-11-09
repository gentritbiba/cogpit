import { scopeParsedSession, splitInstanceDirName } from "../../shared/session/instances"
import { useCallback, useEffect, useRef, useState } from "react"
import { openSessionStream } from "@/lib/sessionStream"
import type { SessionDigest, SessionView } from "../../shared/session/sessionDigest"
import type { RateLimitBlock } from "../../shared/session/rateLimit"
import type { SessionSource } from "@/lib/sessionSource"
import { createStreamingOverlayStore } from "@/lib/streamingOverlayStore"
import { sessionCache } from "@/lib/sessionCache"
import { RESULT_PROJECTION } from "../../shared/contracts/toolResults"
import { WATCH_STREAM_VERSION } from "../../shared/contracts/watchStream"
import {
  applyDeltas,
  applySnapshot,
  reconcileWithLines,
  sweepStale,
  EMPTY_OVERLAY,
  type StreamingOverlay,
} from "@/lib/streamingOverlay"

export type SseConnectionState = "connecting" | "connected" | "disconnected"

/** Shared empty map so an unchanged "no progress" state never re-renders consumers. */
const EMPTY_AGENT_PROGRESS: Record<string, string> = {}

/** A parse that keeps failing, a session the worker lost, or a reset repeated on every reconnect would otherwise reload each time. */
export const RESYNC_COOLDOWN_MS = 10_000

export function useLiveSession(
  source: SessionSource | null,
  /** A streamed update of the load `loadId`. */
  onUpdate: (session: SessionView, loadId: number) => void,
  workerParse: (text: string) => Promise<SessionView>,
  workerAppend: (existing: SessionView, newText: string) => Promise<SessionView>,
  /**
   * Reload the session from disk: when the stream cannot resume, the worker
   * lost the session, or a batch keeps failing. A reload already waiting to
   * retry keeps its wait.
   */
  onResync: ((options: { keepBackoff: boolean }) => void) | undefined,
  /** The session `source` loaded, read when the stream starts. */
  loadedSession: () => SessionView | null,
) {
  const [isLive, setIsLive] = useState(false)
  const [sseState, setSseState] = useState<SseConnectionState>("disconnected")
  const [isCompacting, setIsCompacting] = useState(false)
  // A turn that failed with no HTTP response waiting on it (see
  // streamBus.publishError). Cleared as soon as a new turn produces tokens.
  const [turnError, setTurnError] = useState<string | null>(null)
  // Latest AI-generated progress line per running subagent, keyed by the
  // Task/Agent tool_use id whose card it decorates. Absent until the first
  // ~30s fork lands, and empty for a session that spawns no subagents.
  const [agentProgress, setAgentProgress] = useState<Record<string, string>>(EMPTY_AGENT_PROGRESS)
  // Predicted next prompt for the composer. The CLI suppresses these on the
  // first turn, in plan mode, and after an error, so null is the normal case.
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null)
  // The runtime refused the turn on a spent allowance. Sticky by design: the
  // refusal ends the turn, so this has to outlive the stream_clear that follows
  // it and lift only when the allowance comes back or a later turn runs.
  const [rateLimit, setRateLimit] = useState<RateLimitBlock | null>(null)
  // Ephemeral token-streaming overlay (SDK-driven sessions only). Never
  // touches the worker/SessionView pipeline — see src/lib/streamingOverlay.
  const [streamingOverlayStore] = useState(createStreamingOverlayStore)
  const sessionRef = useRef<SessionView | null>(null)
  const overlayRef = useRef<StreamingOverlay>(EMPTY_OVERLAY)
  const sseStateRef = useRef<SseConnectionState>("disconnected")
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate
  const onResyncRef = useRef(onResync)
  onResyncRef.current = onResync
  const workerParseRef = useRef(workerParse)
  workerParseRef.current = workerParse
  const workerAppendRef = useRef(workerAppend)
  workerAppendRef.current = workerAppend
  const loadedSessionRef = useRef(loadedSession)
  loadedSessionRef.current = loadedSession
  const lastResyncAtRef = useRef(0)
  // Streamed lines whose overlay messages go once the update holding them is on screen.
  const landingRef = useRef<{ digest: SessionDigest; lines: string[] } | null>(null)

  // Dropping an overlay message when its line arrives would blank its text for
  // as long as the worker and the render take; dropping it with the commit that
  // shows the parsed line hands the text over in one frame. Called from a
  // layout effect of whatever renders the session.
  const sessionShown = useCallback((shown: SessionView | null) => {
    const landing = landingRef.current
    if (!landing || shown?.digest !== landing.digest) return
    landingRef.current = null
    const next = reconcileWithLines(overlayRef.current, landing.lines)
    if (next === overlayRef.current) return
    overlayRef.current = next
    streamingOverlayStore.publish(next)
  }, [streamingOverlayStore])

  const dirName = source?.dirName ?? null
  const fileName = source?.fileName ?? null
  const watchOffset = source?.watchOffset ?? 0
  const loadId = source?.loadId ?? 0

  // The stream restarts on every load from disk (a switch, a reload after undo),
  // never while it streams.
  useEffect(() => {
    sessionRef.current = loadedSessionRef.current()
    // A prediction belongs to the turn that produced it — never to whatever
    // session is loaded next. A block or a failed turn belongs to the session
    // that hit it; the watcher replays a standing block on connect.
    setPromptSuggestion(null)
    setRateLimit(null)
    setTurnError(null)
    if (!dirName || !fileName) {
      setIsLive(false)
      setSseState("disconnected")
      return
    }

    setSseState("connecting")

    // Every (re)connect resumes after the last line received, so nothing is replayed.
    let appliedEnd = watchOffset
    const url = `/api/watch/${encodeURIComponent(dirName)}/${encodeURIComponent(fileName)}?projection=${RESULT_PROJECTION}&stream=${WATCH_STREAM_VERSION}`
    const stream = openSessionStream(url, { connectUrl: () => `${url}&offset=${appliedEnd}` })
    const es = stream.source
    let staleTimer: ReturnType<typeof setTimeout> | null = null

    const resetStaleTimer = (ms = 30_000) => {
      if (staleTimer) clearTimeout(staleTimer)
      staleTimer = setTimeout(() => {
        setIsLive(false)
        // A dropped stream never delivers the end of the compaction, so clear
        // the flag here — otherwise "Compressing context…" is pinned forever.
        setIsCompacting(false)
      }, ms)
    }

    // ── SSE burst coalescing ────────────────────────────────────────────
    // Heavy bash output produces many SSE messages per second. Each worker
    // round trip answers with the turns it changed, and the last turn usually
    // changes every time, so sending messages one by one would copy and render
    // that turn once per message.
    //
    // Instead, accumulate incoming text in `pendingText` while the worker is
    // busy and flush it as a single batch when the worker becomes idle.
    // Ordering is preserved because text fragments are appended in arrival
    // order and only one worker call is in flight at a time.
    let pendingText = ""
    let pendingLines: string[] = []
    let workerBusy = false
    let closed = false
    let pendingUpdate = false
    let rafId: number | null = null

    const flushUpdate = () => {
      pendingUpdate = false
      rafId = null
      if (sessionRef.current) {
        onUpdateRef.current(sessionRef.current, loadId)
      }
    }

    const scheduleUpdate = () => {
      if (pendingUpdate) return
      pendingUpdate = true
      rafId = requestAnimationFrame(flushUpdate)
    }

    // ── Streaming overlay flushing ──────────────────────────────────────
    // Overlay deltas arrive at up to ~13 Hz; mutate the ref and publish to
    // subscribers at most once per animation frame. The owner and app shell
    // never subscribe to token updates.
    let overlayDirty = false
    let overlayRafId: number | null = null
    let staleSweep: ReturnType<typeof setInterval> | null = null

    const flushOverlay = () => {
      overlayDirty = false
      overlayRafId = null
      streamingOverlayStore.publish(overlayRef.current)
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

    // Progress summaries decorate the very transcripts the overlay feeds, so
    // they go whenever it does — a compaction, a turn end, or a dropped stream.
    const clearOverlay = () => {
      setOverlay(EMPTY_OVERLAY)
      setAgentProgress(EMPTY_AGENT_PROGRESS)
    }

    const resync = () => {
      const now = Date.now()
      if (!onResyncRef.current || now - lastResyncAtRef.current < RESYNC_COOLDOWN_MS) return
      lastResyncAtRef.current = now
      onResyncRef.current({ keepBackoff: true })
    }

    const flushToWorker = () => {
      if (closed || workerBusy || !pendingText) return
      const toFlush = pendingText
      const flushedLines = pendingLines
      const flushedEnd = appliedEnd
      pendingText = ""
      pendingLines = []
      workerBusy = true

      const base = sessionRef.current
      const parsePromise = base
        ? workerAppendRef.current(base, toFlush)
        : workerParseRef.current(toFlush)
      let failed = false

      parsePromise
        .then((parsedResult) => {
          const result = scopeParsedSession(parsedResult, splitInstanceDirName(dirName).instanceId)
          // Cached even after the stream closed: the worker already holds this
          // version, and a switch back resumes from the entry.
          sessionCache.update(dirName, fileName, loadId, {
            parsed: result,
            source: { watchOffset: flushedEnd },
          })
          if (closed) return
          sessionRef.current = result
          landingRef.current = { digest: result.digest, lines: [...(landingRef.current?.lines ?? []), ...flushedLines] }
          scheduleUpdate()
        }, (err) => {
          console.error("[useLiveSession] worker parse failed:", err)
          if (closed) return
          // Keep the lines: the next batch retries them, or the resync
          // replaces this stream with one that starts after them.
          failed = true
          pendingText = toFlush + pendingText
          pendingLines = [...flushedLines, ...pendingLines]
          resync()
        })
        .catch((err) => {
          console.error("[useLiveSession] live update failed:", err)
        })
        .finally(() => {
          workerBusy = false
          // Drain anything that accumulated while the worker was busy — this
          // is where the O(1) burst compression happens.
          if (!closed && !failed && pendingText) flushToWorker()
        })
    }

    es.onopen = () => {
      if (sseStateRef.current !== "connected") {
        sseStateRef.current = "connected"
        setSseState("connected")
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
        } else if (data.type === "compacting") {
          if (data.active) {
            setIsLive(true)
            clearOverlay()
            resetStaleTimer()
          }
          setIsCompacting(data.active === true)
        } else if (data.type === "subagent_activity") {
          // The server's word that agents the session started are still
          // working; the parent stream goes quiet while they run.
          setIsLive(true)
          resetStaleTimer()
        } else if (data.type === "runtime_activity") {
          setIsLive(true)
          resetStaleTimer()
        } else if (data.type === "stream_snapshot") {
          // Mid-turn connect/reconnect: replace the overlay wholesale.
          setIsLive(true)
          resetStaleTimer()
          setOverlay(applySnapshot(data.messages ?? []))
        } else if (data.type === "stream_delta") {
          setIsLive(true)
          resetStaleTimer()
          // Tokens are flowing again — whatever failed before is now history,
          // and so is a suggestion predicting the prompt that just went out.
          setTurnError(null)
          setPromptSuggestion(null)
          // A turn that streams tokens is a turn being served, whatever the
          // last rate-limit report said.
          setRateLimit(null)
          setOverlay(applyDeltas(overlayRef.current, data.events ?? []))
        } else if (data.type === "rate_limit") {
          setRateLimit((data.block as RateLimitBlock | null) ?? null)
        } else if (data.type === "agent_progress") {
          setIsLive(true)
          resetStaleTimer()
          setAgentProgress((prev) => ({ ...prev, [data.toolUseId]: data.summary }))
        } else if (data.type === "prompt_suggestion") {
          // Emitted after the turn's result, so it deliberately outlives the
          // stream_clear that immediately precedes it.
          setPromptSuggestion(typeof data.suggestion === "string" ? data.suggestion : null)
        } else if (data.type === "turn_error") {
          setTurnError(typeof data.message === "string" ? data.message : "The turn failed")
        } else if (data.type === "stream_clear") {
          clearOverlay()
          setIsCompacting(false)
        } else if (data.type === "reset") {
          // The stream cannot resume from here, so load the session again. The
          // server ends the stream and repeats this on every reconnect until the
          // reload lands.
          resync()
        } else if (data.type === "lines") {
          if (typeof data.end === "number") {
            if (data.end <= appliedEnd) return
            appliedEnd = data.end
          } else {
            // A server without stream v2 states the native bytes of a projected
            // event; an unprojected one covers its lines and the ones left out.
            appliedEnd += typeof data.bytes === "number"
              ? data.bytes
              : (data.skippedBytes ?? 0) + new TextEncoder().encode(data.lines.map((line: string) => `${line}\n`).join("")).byteLength
          }
          if (data.lines.length === 0) return
          setIsLive(true)
          setIsCompacting(false)
          resetStaleTimer()

          pendingText += data.lines.join("\n") + "\n"
          pendingLines.push(...data.lines)
          flushToWorker()
        }
      } catch (err) {
        console.error("[useLiveSession] Error processing SSE message:", err)
      }
    }

    es.onerror = () => {
      setIsLive(false)
      setIsCompacting(false)
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
      stream.close()
      setIsLive(false)
      sseStateRef.current = "disconnected"
      setSseState("disconnected")
      if (staleTimer) clearTimeout(staleTimer)
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (overlayRafId !== null) cancelAnimationFrame(overlayRafId)
      if (staleSweep) clearInterval(staleSweep)
      overlayRef.current = EMPTY_OVERLAY
      landingRef.current = null
      streamingOverlayStore.publish(EMPTY_OVERLAY)
    }
  }, [dirName, fileName, loadId, watchOffset, streamingOverlayStore])

  return { isLive, sseState, isCompacting, streamingOverlayStore, sessionShown, turnError, agentProgress, promptSuggestion, rateLimit }
}
