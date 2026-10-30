import { useCallback, useEffect, useRef, useState } from "react"
import type { ElidedResult } from "../../shared/session/types"
import type { ToolResultUnavailable } from "../../shared/contracts/toolResults"
import { BodyUnavailable, fetchBodyChunk } from "@/lib/toolResultBodies"

export type ToolResultBodyState =
  | { status: "idle" }
  | { status: "loading"; text?: string }
  | { status: "ready"; text: string; total: number; complete: boolean; loadingMore: boolean }
  | { status: "unavailable"; reason: ToolResultUnavailable; message: string }

/**
 * The full body of an elided result while `active` (its reader expanded it),
 * fetched on demand in chunks. Turning `active` off aborts what is in flight;
 * the fetched chunks stay in the shared cache for the next expansion.
 */
export function useToolResultBody(stub: ElidedResult | undefined, active: boolean): ToolResultBodyState & { loadMore: () => void; retry: () => void } {
  const [state, setState] = useState<ToolResultBodyState>({ status: "idle" })
  const [attempt, setAttempt] = useState(0)
  const controllerRef = useRef<AbortController | null>(null)
  const ref = stub?.ref
  const stubRef = useRef(stub)
  stubRef.current = stub

  useEffect(() => {
    const current = stubRef.current
    if (!ref || !current || !active) {
      setState({ status: "idle" })
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    setState({ status: "loading" })
    fetchBodyChunk(current, 0, controller.signal).then((chunk) => {
      if (!controller.signal.aborted) setState({ status: "ready", text: chunk.text, total: chunk.total, complete: chunk.end >= chunk.total, loadingMore: false })
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      setState(error instanceof BodyUnavailable
        ? { status: "unavailable", reason: error.reason, message: error.message }
        : { status: "unavailable", reason: "error", message: "The output could not be loaded." })
    })
    return () => {
      controller.abort()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [ref, active, attempt])

  const loadMore = useCallback(() => {
    const controller = controllerRef.current
    const current = stubRef.current
    if (!ref || !current || !controller || state.status !== "ready" || state.complete || state.loadingMore) return
    const loaded = state.text
    setState({ ...state, loadingMore: true })
    fetchBodyChunk(current, loaded.length, controller.signal).then((chunk) => {
      if (controller.signal.aborted) return
      const text = loaded + chunk.text
      setState({ status: "ready", text, total: chunk.total, complete: chunk.end >= chunk.total, loadingMore: false })
    }, (error: unknown) => {
      if (controller.signal.aborted) return
      setState(error instanceof BodyUnavailable
        ? { status: "unavailable", reason: error.reason, message: error.message }
        : { status: "unavailable", reason: "error", message: "The rest of the output could not be loaded." })
    })
  }, [ref, state])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  return { ...state, loadMore, retry }
}
