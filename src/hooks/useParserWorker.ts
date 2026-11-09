import { useRef, useEffect, useCallback } from "react"
import { parseSession } from "../../shared/session/parser"
import { liftElidedResults } from "../../shared/session/resultProjection"
import { toSessionView, type SessionView } from "../../shared/session/sessionDigest"
import type { Turn } from "../../shared/session/types"
import { applySessionDelta } from "@/lib/sessionDelta"
import { sessionCache } from "@/lib/sessionCache"
import type { KeptVersion, WorkerRequest, WorkerResponse } from "@/workers/session-parser.worker"

/** A worker that has not answered by then is treated as dead and replaced. */
export const WORKER_REQUEST_TIMEOUT_MS = 60_000

/** The worker no longer holds the session an append was made to; load it again. */
export class SessionHandleLostError extends Error {
  constructor() {
    super("The parser worker no longer holds this session")
    this.name = "SessionHandleLostError"
  }
}

type Answer = Exclude<WorkerResponse, { type: "error" }>

type PendingRequest = {
  resolve: (answer: Answer) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never
type RequestBody = WithoutId<WorkerRequest>

export function useParserWorker() {
  const sendRef = useRef<((body: RequestBody) => Promise<Answer>) | null>(null)
  // The version the worker keeps each view under, keyed by the view's turns,
  // which an instance-scoped copy of the view shares.
  const keptRef = useRef(new WeakMap<Turn[], KeptVersion>())
  // Each turn object's version, so an append can tell which turns it changed.
  const versionsRef = useRef(new WeakMap<Turn, number>())
  // The session the live stream last appended to; its next batch may already be on the way.
  const streamingRef = useRef<number | null>(null)
  const releaseRef = useRef<((handle: number) => void) | null>(null)

  useEffect(() => {
    const pending = new Map<number, PendingRequest>()
    let nextId = 0
    let worker: Worker
    let disposed = false

    const settle = (id: number): PendingRequest | undefined => {
      const request = pending.get(id)
      if (!request) return undefined
      pending.delete(id)
      clearTimeout(request.timer)
      return request
    }

    const rejectAll = (error: Error) => {
      for (const id of [...pending.keys()]) settle(id)?.reject(error)
    }

    // A worker can crash, or be stopped at its heap limit without any event,
    // and every later request would then wait forever. Start a fresh one.
    const replace = (error: Error) => {
      worker.terminate()
      rejectAll(error)
      // The new worker numbers its sessions from scratch, so no view may name one.
      keptRef.current = new WeakMap()
      streamingRef.current = null
      if (!disposed) worker = spawn()
    }

    const spawn = (): Worker => {
      const next = new Worker(
        new URL("@/workers/session-parser.worker.ts", import.meta.url),
        { type: "module" },
      )
      next.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data
        const request = settle(msg.id)
        if (!request) return
        if (msg.type === "error") request.reject(new Error(msg.error))
        else request.resolve(msg)
      }
      next.onerror = (err) => replace(new Error(`Worker error: ${err.message}`))
      next.onmessageerror = () => replace(new Error("Worker sent a message that could not be read"))
      return next
    }

    worker = spawn()
    sendRef.current = (body) => new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => replace(new Error("Worker did not answer")), WORKER_REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      try {
        worker.postMessage({ ...body, id } as WorkerRequest)
      } catch (err) {
        settle(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })

    // The worker keeps a session for as long as the renderer holds a view of it.
    const handleOf = (view: SessionView) => keptRef.current.get(view.turns)?.handle
    const releaseUnheld = (handle: number) => {
      if (handle === streamingRef.current) return
      for (const view of sessionCache.heldViews()) if (handleOf(view) === handle) return
      worker.postMessage({ type: "release", handle } satisfies WorkerRequest)
    }
    releaseRef.current = releaseUnheld
    const stopReleasing = sessionCache.onRelease((view) => {
      const handle = handleOf(view)
      if (handle !== undefined) releaseUnheld(handle)
    })

    return () => {
      disposed = true
      stopReleasing()
      releaseRef.current = null
      sendRef.current = null
      worker.terminate()
      rejectAll(new Error("Worker terminated"))
    }
  }, [])

  const request = useCallback(async (text: string, keep: boolean): Promise<SessionView> => {
    const send = sendRef.current
    if (!send) return toSessionView(liftElidedResults(parseSession(text)))
    const answer = await send({ type: "parse", text, keep })
    if (answer.type !== "parsed") throw new Error(`Unexpected worker answer: ${answer.type}`)
    const { view, turnVersions, kept } = answer
    view.turns.forEach((turn, index) => versionsRef.current.set(turn, turnVersions[index]!))
    if (kept) keptRef.current.set(view.turns, kept)
    return view
  }, [])

  /** Parses a session the worker keeps, so the live stream can append to it. */
  const parse = useCallback((text: string) => request(text, true), [request])

  /** Parses a page of older turns, which nothing appends to. */
  const parsePage = useCallback((text: string) => request(text, false), [request])

  /**
   * Appends to a session the worker keeps, sending only `newText` and
   * receiving only the turns that changed. Rejects with
   * `SessionHandleLostError` when the worker no longer holds `existing`.
   */
  const append = useCallback(async (existing: SessionView, newText: string): Promise<SessionView> => {
    const stream = (handle: number | null) => {
      const previous = streamingRef.current
      streamingRef.current = handle
      if (previous !== null && previous !== handle) releaseRef.current?.(previous)
    }
    const send = sendRef.current
    const base = keptRef.current.get(existing.turns)
    // A session created empty holds nothing an append could lose.
    if (!base && existing.turns.length === 0) {
      const view = await parse(newText)
      stream(keptRef.current.get(view.turns)?.handle ?? null)
      return view
    }
    if (!send || !base) throw new SessionHandleLostError()
    stream(base.handle)
    const answer = await send({ type: "append", base, newText })
    if (answer.type === "missing") throw new SessionHandleLostError()
    if (answer.type !== "delta") throw new Error(`Unexpected worker answer: ${answer.type}`)
    const view = applySessionDelta(existing, answer.delta, versionsRef.current)
    keptRef.current.set(view.turns, answer.kept)
    return view
  }, [parse])

  return { parse, parsePage, append }
}
