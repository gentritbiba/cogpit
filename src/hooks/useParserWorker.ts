import { useRef, useEffect, useCallback } from "react"
import { parseSession, parseSessionAppend } from "../../shared/session/parser"
import type { ParsedSession } from "../../shared/session/types"
import type { WorkerRequest, WorkerResponse } from "@/workers/session-parser.worker"

/** A worker that has not answered by then is treated as dead and replaced. */
export const WORKER_REQUEST_TIMEOUT_MS = 60_000

type PendingRequest = {
  resolve: (session: ParsedSession) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never
type RequestBody = WithoutId<WorkerRequest>

export function useParserWorker() {
  const sendRef = useRef<((body: RequestBody) => Promise<ParsedSession>) | null>(null)

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
    if (!send) return Promise.resolve().then(() => parseSession(text))
    return send({ type: "parse", text })
  }, [])

  const append = useCallback(
    (existing: ParsedSession, newText: string): Promise<ParsedSession> => {
      const send = sendRef.current
      if (!send) return Promise.resolve().then(() => parseSessionAppend(existing, newText))
      return send({ type: "append", existing, newText })
    },
    [],
  )

  return { parse, append }
}
