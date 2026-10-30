import { useRef, useEffect, useCallback } from "react"
import { parseSession, parseSessionAppend } from "../../shared/session/parser"
import { liftElidedResults } from "../../shared/session/resultProjection"
import type { ParsedSession, Turn } from "../../shared/session/types"
import type { KeptVersion, WorkerRequest, WorkerResponse } from "@/workers/session-parser.worker"

/** A worker that has not answered by then is treated as dead and replaced. */
export const WORKER_REQUEST_TIMEOUT_MS = 60_000

type PendingRequest = {
  resolve: (session: ParsedSession | null) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** What a request resolves with when the worker no longer holds the session an append named. */
const MISSING = null

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never
type RequestBody = WithoutId<WorkerRequest>

export function useParserWorker() {
  const sendRef = useRef<((body: RequestBody) => Promise<ParsedSession | null>) | null>(null)
  // The version the worker keeps each live session under, keyed by its turns,
  // which an instance-scoped copy of the session shares.
  const keptRef = useRef(new WeakMap<Turn[], KeptVersion>())
  const nextHandleRef = useRef(0)

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
        if (msg.type === "result") request.resolve(msg.session)
        else if (msg.type === "missing") request.resolve(MISSING)
        else request.reject(new Error(msg.error))
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

    return () => {
      disposed = true
      sendRef.current = null
      worker.terminate()
      rejectAll(new Error("Worker terminated"))
    }
  }, [])

  const parse = useCallback((text: string): Promise<ParsedSession> => {
    const send = sendRef.current
    if (!send) return Promise.resolve().then(() => liftElidedResults(parseSession(text)))
    return send({ type: "parse", text }).then((session) => session!)
  }, [])

  /**
   * Appends to a session, sending only `newText` when the worker still holds
   * `existing` from the append that produced it, and the whole session
   * otherwise. The result is kept in the worker for the next append.
   */
  const append = useCallback(
    async (existing: ParsedSession, newText: string): Promise<ParsedSession> => {
      const send = sendRef.current
      if (!send) return liftElidedResults(parseSessionAppend(existing, newText))
      const base = keptRef.current.get(existing.turns)
      const keep: KeptVersion = { handle: base?.handle ?? nextHandleRef.current++, version: (base?.version ?? 0) + 1 }
      const session = (base && await send({ type: "append", base, newText, keep }))
        ?? await send({ type: "append", existing, newText, keep })
      if (!session) throw new Error("Worker lost the session it was appending to")
      keptRef.current.set(session.turns, keep)
      return session
    },
    [],
  )

  return { parse, append }
}
