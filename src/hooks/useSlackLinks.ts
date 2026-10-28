import { useCallback, useEffect, useRef, useState } from "react"

import { authFetch } from "@/lib/auth"
import { readError } from "@/lib/httpJson"
import type { SlackLinksReport } from "../../shared/contracts/slack"

export type SlackLinksState =
  | { status: "loading" }
  | { status: "ok"; report: SlackLinksReport }
  | { status: "error"; error: string }

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function fetchReport(): Promise<SlackLinksState> {
  try {
    const res = await authFetch("/api/slack")
    return res.ok ? { status: "ok", report: await res.json() } : { status: "error", error: await readError(res, `Request failed (${res.status})`) }
  } catch (err) {
    return { status: "error", error: messageOf(err) }
  }
}

/** The host's Slack links, plus the two changes the app may make to one: its settings, and unlinking it. */
export function useSlackLinks() {
  const [state, setState] = useState<SlackLinksState>({ status: "loading" })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Only the newest read may land: a change, or unmounting, makes every read already under way stale.
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const mine = ++generation.current
    const next = await fetchReport()
    if (mine === generation.current) setState(next)
  }, [])

  useEffect(() => {
    const reads = generation
    void refresh()
    return () => {
      reads.current++
    }
  }, [refresh])

  const act = useCallback(async (sessionId: string, body: Record<string, unknown>) => {
    setBusy(sessionId)
    setError(null)
    generation.current++
    try {
      const res = await authFetch("/api/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ...body }),
      })
      if (!res.ok) setError(await readError(res, `Request failed (${res.status})`))
      await refresh()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(null)
    }
  }, [refresh])

  const setAutoPost = useCallback((sessionId: string, autoPost: boolean) => act(sessionId, { action: "update", autoPost }), [act])
  const unlink = useCallback((sessionId: string) => act(sessionId, { action: "unlink" }), [act])

  return { state, busy, error, refresh, setAutoPost, unlink }
}
