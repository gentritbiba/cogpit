import { useCallback, useEffect, useRef, useState } from "react"

import { authFetch } from "@/lib/auth"
import { readError } from "@/lib/httpJson"

export type ReportState<T> =
  | { status: "loading" }
  | { status: "ok"; report: T }
  /** `httpStatus` is set when the server answered and refused. */
  | { status: "error"; error: string; httpStatus?: number }

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function fetchReport<T>(route: string): Promise<ReportState<T>> {
  try {
    const res = await authFetch(route)
    return res.ok
      ? { status: "ok", report: await res.json() }
      : { status: "error", error: await readError(res, `Request failed (${res.status})`), httpStatus: res.status }
  } catch (err) {
    return { status: "error", error: messageOf(err) }
  }
}

/**
 * A settings report read from `route` when the component mounts and again on
 * `refresh`. Only the newest read may land: a change, or unmounting, makes
 * every read already under way stale.
 */
export function useReport<T>(route: string) {
  const [state, setState] = useState<ReportState<T>>({ status: "loading" })
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const mine = ++generation.current
    const next = await fetchReport<T>(route)
    if (mine === generation.current) setState(next)
  }, [route])

  useEffect(() => {
    const reads = generation
    void refresh()
    return () => {
      reads.current++
    }
  }, [refresh])

  /** Call before a change, so no read begun earlier lands after it. The token goes to `land`. */
  const supersede = useCallback(() => ++generation.current, [])
  /** Show the report a change answered with, unless something newer began since `token`. */
  const land = useCallback((token: number, report: T) => {
    if (token === generation.current) setState({ status: "ok", report })
  }, [])

  return { state, refresh, supersede, land }
}
