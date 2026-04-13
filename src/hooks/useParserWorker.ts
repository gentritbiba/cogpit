import { useRef, useEffect, useCallback } from "react"
import type { ParsedSession } from "@/lib/types"
import type { WorkerRequest, WorkerResponse } from "@/workers/session-parser.worker"

type PendingRequest = {
  resolve: (session: ParsedSession) => void
  reject: (error: Error) => void
}

export function useParserWorker() {
  const workerRef = useRef<Worker | null>(null)
  const pendingRef = useRef<Map<number, PendingRequest>>(new Map())
  const nextIdRef = useRef(0)

  useEffect(() => {
    const worker = new Worker(
      new URL("@/workers/session-parser.worker.ts", import.meta.url),
      { type: "module" },
    )

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      const pending = pendingRef.current.get(msg.id)
      if (!pending) return
      pendingRef.current.delete(msg.id)

      if (msg.type === "result") {
        pending.resolve(msg.session)
      } else {
        pending.reject(new Error(msg.error))
      }
    }

    worker.onerror = (err) => {
      // Reject all pending requests on worker crash
      for (const [, pending] of pendingRef.current) {
        pending.reject(new Error(`Worker error: ${err.message}`))
      }
      pendingRef.current.clear()
    }

    workerRef.current = worker

    return () => {
      worker.terminate()
      workerRef.current = null
      // Reject any remaining pending requests
      for (const [, pending] of pendingRef.current) {
        pending.reject(new Error("Worker terminated"))
      }
      pendingRef.current.clear()
    }
  }, [])

  const parse = useCallback((text: string): Promise<ParsedSession> => {
    return new Promise((resolve, reject) => {
      const worker = workerRef.current
      if (!worker) {
        // Fallback: import parser directly (shouldn't happen in practice)
        import("@/lib/parser")
          .then(({ parseSession }) => {
            resolve(parseSession(text))
          })
          .catch(reject)
        return
      }
      const id = nextIdRef.current++
      pendingRef.current.set(id, { resolve, reject })
      worker.postMessage({ type: "parse", id, text } satisfies WorkerRequest)
    })
  }, [])

  const append = useCallback(
    (existing: ParsedSession, newText: string): Promise<ParsedSession> => {
      return new Promise((resolve, reject) => {
        const worker = workerRef.current
        if (!worker) {
          import("@/lib/parser")
            .then(({ parseSessionAppend }) => {
              resolve(parseSessionAppend(existing, newText))
            })
            .catch(reject)
          return
        }
        const id = nextIdRef.current++
        pendingRef.current.set(id, { resolve, reject })
        worker.postMessage({ type: "append", id, existing, newText } satisfies WorkerRequest)
      })
    },
    [],
  )

  return { parse, append }
}
