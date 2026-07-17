import { useRef, useEffect, useCallback } from "react"
import { parseSession, parseSessionAppend } from "@/lib/parser"
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
    const pending = pendingRef.current
    const worker = new Worker(
      new URL("@/workers/session-parser.worker.ts", import.meta.url),
      { type: "module" },
    )

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      const request = pending.get(msg.id)
      if (!request) return
      pending.delete(msg.id)

      if (msg.type === "result") {
        request.resolve(msg.session)
      } else {
        request.reject(new Error(msg.error))
      }
    }

    worker.onerror = (err) => {
      // Reject all pending requests on worker crash
      for (const [, request] of pending) {
        request.reject(new Error(`Worker error: ${err.message}`))
      }
      pending.clear()
    }

    workerRef.current = worker

    return () => {
      worker.terminate()
      workerRef.current = null
      // Reject any remaining pending requests
      for (const [, request] of pending) {
        request.reject(new Error("Worker terminated"))
      }
      pending.clear()
    }
  }, [])

  const parse = useCallback((text: string): Promise<ParsedSession> => {
    const worker = workerRef.current
    if (!worker) return Promise.resolve().then(() => parseSession(text))

    return new Promise((resolve, reject) => {
      const id = nextIdRef.current++
      pendingRef.current.set(id, { resolve, reject })
      worker.postMessage({ type: "parse", id, text } satisfies WorkerRequest)
    })
  }, [])

  const append = useCallback(
    (existing: ParsedSession, newText: string): Promise<ParsedSession> => {
      const worker = workerRef.current
      if (!worker) {
        return Promise.resolve().then(() => parseSessionAppend(existing, newText))
      }

      return new Promise((resolve, reject) => {
        const id = nextIdRef.current++
        pendingRef.current.set(id, { resolve, reject })
        worker.postMessage({ type: "append", id, existing, newText } satisfies WorkerRequest)
      })
    },
    [],
  )

  return { parse, append }
}
